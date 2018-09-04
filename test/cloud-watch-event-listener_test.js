
const _ = require('lodash');
const main = require('../lib/main');
const assume = require('assume');
const sinon = require('sinon');
const subject = require('../lib/cloud-watch-event-listener');
const {CloudWatchEventListener} = subject;
const runaws = require('../lib/aws-request');

// This is the basis of an example message from cloud watch.  The only thing
// which should change is the state in the detail object.  Intentionally a
// const
const baseExampleMsg = {
  version: '0',
  id: '9129eb4e-07c0-484e-b2a5-204386a2d7fd',
  'detail-type': 'EC2 Instance State-change Notification',
  source: 'aws.ec2',
  account: '692406183521',
  time: '2017-06-04T13:14:15Z',
  region: 'us-west-2',
  resources: [
    'arn:aws:ec2:us-west-2:692406183521:instance/i-0d0cf3d89cbab142c',
  ],
  detail: {
    'instance-id': 'i-0d0cf3d89cbab142c',
    state: 'pending',
  },
};

describe('Cloud Watch Event Listener', () => {
  let sandbox = sinon.sandbox.create();
  let state;
  let ec2;
  let sqs;
  let region = 'us-west-2';
  let az = 'us-west-2a';
  let instanceType = 'c3.xlarge';
  let imageId = 'ami-1';
  let listener;
  let tagger;

  before(async () => {
    // We want a clean DB state to verify things happen as we intend
    state = await main('state', {profile: 'test', process: 'test'});

    ec2 = await main('ec2', {profile: 'test', process: 'test'});
    ec2 = ec2[region];

    sqs = await main('sqs', {profile: 'test', process: 'test'});
    sqs = sqs[region];

    let monitor = await main('monitor', {profile: 'test', process: 'test'});
    let cfg = await main('cfg', {profile: 'test', process: 'test'});
    tagger = await main('tagger', {profile: 'test', process: 'test'});

    await state._runScript('drop-db.sql');
    await state._runScript('create-db.sql');

    listener = new CloudWatchEventListener({state, sqs, ec2, region, monitor, tagger});
  });

  after(async () => {
    await state._runScript('drop-db.sql');
  });

  // I could add these helper functions to the actual state.js class but I'd
  // rather not have that be so easy to call by mistake in real code
  beforeEach(async () => {
    await state._runScript('clear-db.sql');
    state = await main('state', {profile: 'test', process: 'test'});
    sandbox.stub(tagger, 'runaws');
  });

  afterEach(() => {
    sandbox.restore();
    // Make sure we're not dropping client references
    for (let client of state._pgpool._clients) {
      try {
        client.release();
        let lastQuery = (client._activeQuery || {}).text;
        let err = new Error('Leaked a client that last executed: ' + lastQuery);
        err.client = client;
        throw err;
      } catch (err) {
        if (!/Release called on client which has already been released to the pool/.exec(err.message)) {
          throw err;
        }
      }
    }
  });

  it('should handle pending message', async () => {
    let mock = sandbox.stub(listener, 'runaws');
    mock.onFirstCall().throws(new Error('shouldnt talk to ec2 api'));

    let pendingTimestamp = new Date();

    await state.insertInstance({
      workerType: 'workertype',
      region,
      instanceType,
      id: 'i-1',
      state: 'pending',
      az,
      launched: pendingTimestamp,
      imageId,
      lastEvent: pendingTimestamp,
    });

    let instances = await state.listInstances();
    assume(instances).lengthOf(1);
    let pendingMsg = _.defaultsDeep({}, baseExampleMsg, {detail: {'instance-id': 'i-1', state: 'pending'}});
    await listener.__handler(JSON.stringify(pendingMsg));
    instances = await state.listInstances();
    assume(instances).lengthOf(1);
  });
  
  it('should handle running transition with the instance already in db in pending state', async () => {
    let pendingTimestamp = new Date();
    let runningTimestamp = new Date(pendingTimestamp);
    runningTimestamp.setMinutes(runningTimestamp.getMinutes() + 1);

    await state.insertInstance({
      workerType: 'workertype',
      region,
      instanceType,
      id: 'i-1',
      state: 'pending',
      az,
      launched: pendingTimestamp,
      imageId,
      lastEvent: pendingTimestamp,
    });

    let mock = sandbox.stub(listener, 'runaws');
    mock.onFirstCall().throws(new Error('shouldnt talk to ec2 api'));

    let instances = await state.listInstances();
    assume(instances).lengthOf(1);
    assume(instances[0]).has.property('lastEvent');
    assume(instances[0].lastEvent.getTime()).equals(pendingTimestamp.getTime());
    let pendingMsg = Object.assign({}, baseExampleMsg, {
      detail: {
        'instance-id': 'i-1',
        state: 'running',
      },
      time: runningTimestamp,
    });

    await listener.__handler(JSON.stringify(pendingMsg));

    instances = await state.listInstances();
    assume(instances).lengthOf(1);
    assume(instances[0]).has.property('lastEvent');
    assume(instances[0].lastEvent.getTime()).equals(runningTimestamp.getTime());
    assume(instances[0].state).equals('running');

    assume(instances).lengthOf(1);
  });  

  it('should handle out of order delivery', async () => {
    let mock = sandbox.stub(listener, 'runaws');
    mock.onFirstCall().throws(new Error('shouldnt talk to ec2 api'));

    let pendingTimestamp = new Date();
    let runningTimestamp = new Date(pendingTimestamp);
    runningTimestamp.setMinutes(runningTimestamp.getMinutes() + 1);

    await state.insertInstance({
      workerType: 'workertype',
      region,
      instanceType,
      id: 'i-1',
      state: 'running',
      az,
      launched: runningTimestamp,
      imageId,
      lastEvent: runningTimestamp,
    });

    let instances = await state.listInstances();
    assume(instances).lengthOf(1);
    assume(instances[0]).has.property('lastEvent');
    assume(instances[0].lastEvent.getTime()).deeply.equals(runningTimestamp.getTime());
    let pendingMsg = Object.assign({}, baseExampleMsg, {
      detail: {
        'instance-id': 'i-1',
        state: 'pending',
      },
      time: pendingTimestamp,
    });

    await listener.__handler(JSON.stringify(pendingMsg));

    instances = await state.listInstances();
    assume(instances).lengthOf(1);
    assume(instances[0]).has.property('lastEvent');
    assume(instances[0].lastEvent.getTime()).equals(runningTimestamp.getTime());
    assume(instances[0].state).equals('running');

    assume(instances).lengthOf(1);
  });

  it('should handle terminated event', async () => {
    let mock = sandbox.stub(listener, 'runaws');
    mock.onFirstCall().throws(new Error('shouldnt talk to ec2 api'));

    await state.insertInstance({
      workerType: 'workertype',
      region,
      instanceType,
      id: 'i-1',
      state: 'pending',
      az,
      launched: new Date(),
      imageId,
      lastEvent: new Date(0),
    });

    let instances = await state.listInstances();
    assume(instances).lengthOf(1);
    let terminations = await state.listTerminations();
    assume(terminations).lengthOf(0);
    let pendingMsg = _.defaultsDeep({}, baseExampleMsg);
    // Not sure why, but _.defaultsDeep wasn't working here
    pendingMsg.detail['instance-id'] = 'i-1';
    pendingMsg.detail.state = 'terminated';
    await listener.__handler(JSON.stringify(pendingMsg));
    instances = await state.listInstances();
    assume(instances).lengthOf(0);
    terminations = await state.listTerminations();
    assume(terminations).lengthOf(1);
  });

});
