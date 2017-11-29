const testing = require('taskcluster-lib-testing');
const taskcluster = require('taskcluster-client');
const assume = require('assume');
const main = require('../lib/main');
const {api} = require('../lib/api');
const sinon = require('sinon');

describe('Api', () => {
  let state;
  let region = 'us-west-2';
  let instanceType = 'c3.xlarge';
  let workerType = 'apiTest';
  let az = 'us-west-2a';
  let created = new Date();
  let launched = new Date();
  let imageId = 'ami-1';
  let client;
  let server;
  let sandbox = sinon.sandbox.create();
  let runaws;
  let regions;

  before(async() => {
    // We want a clean DB state to verify things happen as we intend
    state = await main('state', {profile: 'test', process: 'test'});
    await state._runScript('drop-db.sql');
    await state._runScript('create-db.sql');
    let cfg = await main('cfg', {profile: 'test', process: 'test'});
    regions = cfg.app.regions;

    testing.fakeauth.start({
      hasauth: ['*'],
    });

    let apiRef = api.reference({baseUrl: 'http://localhost:5555/v1'});
    let EC2Manager = taskcluster.createClient(apiRef);

    client = new EC2Manager({
      credentials: {
        clientId: 'hasauth',
        accessToken: 'abcde',
      },
    });
  });

  beforeEach(async() => {
    await state._runScript('clear-db.sql');
    runaws = sandbox.stub();
    server = await main('server', {profile: 'test', process: 'test', runaws});
  });

  after(async () => {
    testing.fakeauth.stop();
    await state._runScript('drop-db.sql');
  });

  afterEach(() => {
    server.terminate();
    sandbox.restore();
  });

  it('api comes up', async() => {
    let result = await client.ping();
    assume(result).has.property('alive', true);
  });

  it('should list worker types', async() => {
    let status = 'pending-evaluation';
    await state.insertInstance({
      id: 'i-1',
      workerType: 'w-1',
      region,
      instanceType,
      state: 'running',
      az,
      launched,
      imageId,
      lastevent: new Date(),
    });
    await state.insertSpotRequest({
      id: 'r-1',
      workerType: 'w-2',
      region,
      instanceType,
      state: 'open',
      status,
      az,
      created,
      imageId,
    });
    let result = await client.listWorkerTypes();
    assume(result).deeply.equals(['w-1', 'w-2']);
  });

  it('should show instance counts', async() => {
    let status = 'pending-evaluation';
    await state.insertInstance({
      id: 'i-1',
      workerType: 'w-1',
      region,
      instanceType,
      state: 'running',
      az,
      launched,
      imageId,
      lastevent: new Date(),
    });
    await state.insertInstance({
      id: 'i-2',
      workerType: 'w-1',
      region,
      instanceType,
      state: 'pending',
      az,
      launched,
      imageId,
      lastevent: new Date(),
    });
    await state.insertSpotRequest({
      id: 'r-1',
      workerType: 'w-1',
      region,
      instanceType,
      state: 'open',
      status,
      az,
      created,
      imageId,
    });
    let result = await client.workerTypeStats('w-1');
    assume(result).deeply.equals({
      pending: [{
        instanceType,
        count: 1,
        type: 'instance',
      }, {
        instanceType,
        count: 1,
        type: 'spot-request',
      }],
      running: [{
        instanceType,
        count: 1,
        type: 'instance',
      }],
    });
  });

  describe('requesting resources', () => {
    let ClientToken;
    let Region;
    let SpotPrice;
    let LaunchSpecification;

    beforeEach(() => {
      ClientToken = 'client-token';
      Region = region;
      SpotPrice = 1.66;

      LaunchSpecification = {
        KeyName: `ec2-manager-test:${workerType}:ffe27db`,
        ImageId: 'ami-1',
        InstanceType: instanceType,
        SecurityGroups: [],
        Placement: {
          AvailabilityZone: az,
        },
      };

      runaws.returns({
        SpotInstanceRequests: [{
          SpotInstanceRequestId: 'r-1',
          LaunchSpecification,
          InstanceType: instanceType,
          State: 'open',
          CreateTime: created.toString(),
          Status: {
            Code: 'pending-evaluation',
          },
        }],
      });
    });

    // NOTE: The idempotency assertions are a combination of trusting Postgres
    // to return the primary key conflict, a check that the worker type
    // argument is the same as that in the LaunchSpecification and that EC2
    // idempotency works
    it('should request a spot instance (idempotent)', async() => {
      await client.requestSpotInstance(workerType, {
        ClientToken, 
        Region,
        SpotPrice,
        LaunchSpecification,
      });

      let requests = await state.listSpotRequests();
      assume(requests).has.lengthOf(1);
      assume(runaws.callCount).equals(2);
      assume(runaws.args[0][1]).equals('requestSpotInstances');
      assume(runaws.args[1][1]).equals('createTags');
      let amiUsage = await state.listAmiUsage();
      assume(amiUsage).has.length(1);
      assume(amiUsage[0]).has.property('region', region);
      assume(amiUsage[0]).has.property('id', imageId);
      let call = runaws.firstCall.args;
      assume(call[0].config.region).equals(region);
      assume(call[1]).equals('requestSpotInstances');
      assume(call[2]).deeply.equals({
        ClientToken,
        SpotPrice: SpotPrice.toString(),
        InstanceCount: 1,
        Type: 'one-time',
        LaunchSpecification,
      });
      runaws.resetHistory();

      await client.requestSpotInstance(workerType, {
        ClientToken, 
        Region,
        SpotPrice,
        LaunchSpecification,
      });
      requests = await state.listSpotRequests();
      assume(requests).has.lengthOf(1);
      assume(runaws.callCount).equals(2);
      assume(runaws.args[0][1]).equals('requestSpotInstances');
      assume(runaws.args[1][1]).equals('createTags');
      amiUsage = await state.listAmiUsage();
      assume(amiUsage).has.length(1);
      assume(amiUsage[0]).has.property('region', region);
      assume(amiUsage[0]).has.property('id', imageId);
    });
  });

  describe('managing resources', () => {
    beforeEach(async() => {
      let status = 'pending-fulfillment';
      await state.insertInstance({
        id: 'i-1',
        workerType,
        region: 'us-east-1',
        instanceType,
        state: 'running',
        az,
        imageId,
        launched,
        lastevent: new Date(),
      });
      await state.insertInstance({
        id: 'i-2',
        workerType,
        region: 'us-west-1',
        instanceType,
        state: 'running',
        az,
        imageId,
        launched,
        lastevent: new Date(),
      });
      await state.insertInstance({
        id: 'i-3',
        workerType,
        region: 'us-west-2',
        instanceType,
        state: 'pending',
        srid: 'r-3',
        az,
        imageId,
        launched,
        lastevent: new Date(),
      });
      // Insert some spot requests
      await state.insertSpotRequest({
        id: 'r-1',
        workerType,
        region: 'us-east-1',
        instanceType,
        state: 'open',
        status,
        az,
        imageId,
        created,
      });
      await state.insertSpotRequest({
        id: 'r-2',
        workerType,
        region: 'us-west-1',
        instanceType,
        state: 'open',
        status,
        az,
        imageId,
        created,
      });
    });

    it('should be able to kill all of a worker type', async() => {
      let result = await client.terminateWorkerType(workerType); 

      // Lengthof doesn't seem to work here.  oh well
      assume(runaws.args).has.property('length', 6);
      for (let call of runaws.args) {
        let region = call[0].config.region;
        let endpoint = call[1];
        let obj = call[2];

        if (endpoint === 'cancelSpotInstanceRequests') {
          if (region === 'us-east-1') {
            assume(obj.SpotInstanceRequestIds).deeply.equals(['r-1']);
          } else if (region === 'us-west-1') {
            assume(obj.SpotInstanceRequestIds).deeply.equals(['r-2']);
          } else if (region === 'us-west-2') {
            assume(obj.SpotInstanceRequestIds).deeply.equals(['r-3']);
          }
        } else if (endpoint === 'terminateInstances') {
          if (region === 'us-east-1') {
            assume(obj.InstanceIds).deeply.equals(['i-1']);
          } else if (region === 'us-west-1') {
            assume(obj.InstanceIds).deeply.equals(['i-2']);
          } else if (region === 'us-west-2') {
            assume(obj.InstanceIds).deeply.equals(['i-3']);
          }
        }
      }
      
      let instances = await state.listInstances();
      let requests = await state.listSpotRequests();
      assume(instances).has.lengthOf(0);
      assume(requests).has.lengthOf(0);
    });

    it('should be able to kill a single instance', async() => {
      runaws.returns({
        TerminatingInstances: [{
          PreviousState: {Name: 'pending'},
          CurrentState: {Name: 'shutting-down'},
        }],
      });
      let result = await client.terminateInstance('us-east-1', 'i-1');
      assume(result).has.property('current', 'shutting-down');
      assume(result).has.property('previous', 'pending');
      assume(runaws.callCount).equals(1);
      let instances = await state.listInstances({id: 'i-1'});
      assume(instances).has.lengthOf(0);
    });
    
    it('should be able to cancel a single spot instance request', async() => {
      runaws.returns({
        CancelledSpotInstanceRequests: [{
          State: 'closed',
        }],
      });
      let result = await client.cancelSpotInstanceRequest('us-east-1', 'r-1');
      assume(runaws.callCount).equals(1);
      assume(result).has.property('current', 'closed');
      let requests = await state.listSpotRequests({id: 'r-1'});
      assume(requests).has.lengthOf(0);
    });
  });

  describe('managing key pairs', () => {
    it('should create and delete keypairs idempotently', async() => {
      // We want the following cases covered:
      // 1. nothing exists in internal cache or ec2 --> create
      // 2. it exists in internal cache --> short circuit return
      // 3. it exists in ec2, not internal --> only describe call
      // 4. it deletes properly if key exists in ec2
      // 5. it deletes properly if key does not exist in ec2

      // Case 1
      runaws.returns({
        KeyPairs: [],
      });
      await client.ensureKeyPair(workerType);
      assume(runaws.callCount).equals(regions.length * 2);
      runaws.reset();

      // Case 2
      await client.ensureKeyPair(workerType);
      assume(runaws.callCount).equals(0);
      runaws.reset();

      // Case 4
      runaws.returns({
        KeyPairs: ['placeholder'],
      });
      await client.removeKeyPair(workerType);
      assume(runaws.callCount).equals(regions.length * 2);
      runaws.reset();

      // Case 5
      runaws.returns({
        KeyPairs: [],
      });
      await client.removeKeyPair(workerType);
      assume(runaws.callCount).equals(regions.length);
      runaws.reset();

      // Case 3 (we do this here so it was deleted from internal cache in
      // remove* calls above
      runaws.returns({
        KeyPairs: ['placeholder'],
      });
      await client.ensureKeyPair(workerType);
      assume(runaws.callCount).equals(regions.length);
    });
  });

  // These are functions which are supposed to be used for debugging and
  // troubleshooting primarily.  Maybe some ui stuff?
  describe('internal api', () => {
    it('should list regions', async() => {
      let result = await client.regions();
      result.regions.sort();
      assume(result.regions).deeply.equals(regions.sort());
    });

    it('should list spot requests to poll', async() => {
      await state.insertSpotRequest({
        workerType: 'abcd',
        region,
        instanceType,
        id: 'r-1234',
        state: 'open',
        status: 'pending-fulfillment',
        az,
        imageId,
        created,
      });
      let result = await client.spotRequestsToPoll();
      assume(result).has.lengthOf(regions.length);
      let usw2 = result.filter(x => x.region === 'us-west-2')[0];
      assume(usw2.values).has.lengthOf(1);
      assume(usw2.values[0]).equals('r-1234');
    });
  
    it('should list AMI usage', async() => {
      await state.reportAmiUsage({
        region: region,
        id: imageId,
      });
      let result = await client.amiUsage();
      assume(result).has.lengthOf(1);
      assume(result[0]).has.property('region', region);
      assume(result[0]).has.property('id', imageId);
    });
    
    it('should list EBS usage', async() => {
      await state.reportEbsUsage({
        region: region,
        volumetype: 'standard',
        state: 'active',
        totalcount: 1,
        totalgb: 8,
      });
      let result = await client.ebsUsage();
      assume(result).has.lengthOf(1);
      assume(result[0]).has.property('volumetype', 'standard');
      assume(result[0]).has.property('state', 'active');
      assume(result[0]).has.property('totalcount', '1');
      assume(result[0]).has.property('totalgb', '8');
    });
  });
});