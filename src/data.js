export const DOMAINS = {
  sensor:       { label: 'Sensor',       color: '#4db8c7' },
  perception:   { label: 'Perception',   color: '#c7943a' },
  localization: { label: 'Localization', color: '#3aaa7a' },
  pnc:          { label: 'PNC',          color: '#5b8fd9' },
  system:       { label: 'System',       color: '#8a73c7' },
  recorder:     { label: 'Recorder',     color: '#777777' },
};

export const PROCESSES = [
  {
    name: 'driver_gnss', domain: 'sensor', runtime: 'mainboard', enabled: true,
    components: ['CompGnssDriver'],
    pub: [
      { topic: '/sensor/novatel/bestgnsspos', proto: 'drivers.gnss.BestPos', comm: 'cyber' },
      { topic: '/sensor/novatel/bestgnssvel', proto: 'drivers.gnss.BestVel', comm: 'cyber' },
      { topic: '/sensor/novatel/Heading',     proto: 'drivers.gnss.Heading', comm: 'cyber' },
      { topic: '/sensor/novatel/Imu',         proto: 'drivers.gnss.RawIMUX', comm: 'cyber' },
    ],
    sub: [],
  },
  {
    name: 'canbus', domain: 'sensor', runtime: 'nexis_app', enabled: true,
    components: ['CanbusExecutor'],
    pub: [
      { topic: '/planning/proxy/DuDriveChassis',       proto: 'status.Chassis',          comm: 'cyber' },
      { topic: '/canbus/vehicle_speed/Vehicle_speed',   proto: 'canbus.PbCarStatus',      comm: 'cyber' },
      { topic: '/canbus/timestamp',                     proto: 'common.header.Header',    comm: 'cyber' },
    ],
    sub: [
      { topic: '/aeb/aeb_cmd',                     proto: 'planning.AebCmd',                 comm: 'cyber' },
      { topic: '/pnc/control',                     proto: 'control.ControlCommand',           comm: 'cyber' },
      { topic: '/patrol/discode',                  proto: 'patrol.DisCode',                   comm: 'cyber' },
      { topic: '/localization/100hz/localization_pose', proto: 'localization.LocalizationEstimate', comm: 'cyber' },
      { topic: '/canbus/horn_light_cmd',           proto: 'status.HornLightsCmd',             comm: 'cyber' },
      { topic: '/planning/pilot_state',            proto: 'planning.PilotState',              comm: 'cyber' },
      { topic: '/openapi/auto_driver_status',      proto: 'common.AutoDriverStatus',          comm: 'cyber' },
      { topic: '/vehicle/self/clean',              proto: 'common.VehicleSelfClean',           comm: 'cyber' },
      { topic: '/perception/environment_monitor',  proto: 'perception.EnvironmentMonitorList', comm: 'cyber' },
      { topic: '/state_machine/transition',        proto: 'state_machine.GlobalStateMachine',  comm: 'cyber' },
    ],
  },
  {
    name: 'location', domain: 'localization', runtime: 'nexis_app', enabled: true,
    components: ['DeadReckoningLocalization', 'InspvaxGnssLocalization'],
    pub: [
      { topic: '/localization/100hz/localization_pose',          proto: 'localization.LocalizationEstimate',       comm: 'cyber', freq: '100Hz' },
      { topic: '/localization/100hz/localization_vehicle_speed', proto: 'localization_dr.LocalizationVehicleSpeed', comm: 'cyber', freq: '100Hz' },
      { topic: '/localization/100hz/inspvax_gnss_msf',           proto: 'common.longshan.TsHeader',                comm: 'cyber', freq: '100Hz' },
    ],
    sub: [
      { topic: '/sensor/novatel/bestgnsspos',               proto: 'drivers.gnss.BestPos',    comm: 'cyber' },
      { topic: '/sensor/novatel/bestgnssvel',               proto: 'drivers.gnss.BestVel',    comm: 'cyber' },
      { topic: '/sensor/novatel/Heading',                   proto: 'drivers.gnss.Heading',    comm: 'cyber' },
      { topic: '/sensor/novatel/Imu',                       proto: 'drivers.gnss.RawIMUX',    comm: 'cyber' },
      { topic: '/canbus/vehicle_speed/Vehicle_speed',       proto: 'canbus.PbCarStatus',      comm: 'cyber' },
    ],
  },
  {
    name: 'model_infer', domain: 'perception', runtime: 'nexis_app', enabled: true,
    components: ['CommonManager', 'one_model_infer'],
    pub: [
      { topic: '/perception/obj_infer',         proto: 'neo_perception.BevMap',                 comm: 'cyber' },
      { topic: '/perception/map_tr_infer',      proto: 'neo_perception.BevMap',                 comm: 'cyber' },
      { topic: '/perception/tld_infer',         proto: 'neo_perception.TrafficLightDetections', comm: 'cyber' },
      { topic: '/perception/occ_infer',         proto: 'neo_perception.OccResult',              comm: 'cyber' },
      { topic: '/perception/parking_occ_infer', proto: 'neo_perception.OccResult',              comm: 'cyber' },
      { topic: '/perception/rod_infer',         proto: 'neo_perception.RodArray',               comm: 'cyber' },
      { topic: '/perception/lane_seg_infer',    proto: 'neo_perception.LaneSegResult',          comm: 'cyber' },
    ],
    sub: [],
  },
  {
    name: 'perception', domain: 'perception', runtime: 'mainboard', enabled: true,
    components: ['NeoRecDynamic', 'TLDComponent(100ms)', 'TrackPredComponent'],
    pub: [
      { topic: '/perception/environment_monitor', proto: 'perception.EnvironmentMonitorList', comm: 'cyber' },
      { topic: '/pnc/prediction',                 proto: 'prediction.PredictionObstacles',    comm: 'cyber' },
    ],
    sub: [
      { topic: '/perception/obj_infer', proto: 'neo_perception.BevMap',                 comm: 'cyber' },
      { topic: '/perception/tld_infer', proto: 'neo_perception.TrafficLightDetections', comm: 'cyber' },
    ],
  },
  {
    name: 'maprouter', domain: 'perception', runtime: 'nexis_app', enabled: true,
    components: ['tld_executor', 'static_executor', 'parking_executor', 'map_router_executor'],
    pub: [
      { topic: '/perception/tld_postprocess',  proto: 'neo_perception.TrafficLightDetections', comm: 'cyber' },
      { topic: '/perception/static',           proto: 'neo_perception.BevMap',                 comm: 'cyber' },
      { topic: '/neo_map_router/router_output', proto: 'map_router.MapRouter',                 comm: 'cyber' },
      { topic: '/maprouter/debug_localmap',    proto: 'neo_perception.BevMap',                 comm: 'cyber' },
      { topic: '/maprouter/navi_cache',        proto: 'map_router.NaviCache',                  comm: 'cyber' },
      { topic: '/perception/occ_fusion_map',   proto: 'neo_perception.OccFusion',              comm: 'cyber' },
      { topic: '/perception/rod_output',       proto: 'neo_perception.RodArray',               comm: 'cyber' },
    ],
    sub: [
      { topic: '/perception/tld_infer',                          proto: 'neo_perception.TrafficLightDetections',     comm: 'cyber' },
      { topic: '/perception/map_tr_infer',                       proto: 'neo_perception.BevMap',                     comm: 'cyber' },
      { topic: '/localization/100hz/localization_vehicle_speed',  proto: 'localization_dr.LocalizationVehicleSpeed',  comm: 'cyber' },
      { topic: '/localization/100hz/inspvax_gnss_msf',           proto: 'localization.LocalizationEstimate',         comm: 'cyber' },
      { topic: '/perception/obj_infer',                          proto: 'neo_perception.BevMap',                     comm: 'cyber' },
      { topic: '/perception/occ_infer',                          proto: 'neo_perception.OccResult',                  comm: 'cyber' },
      { topic: '/perception/lane_seg_infer',                     proto: 'neo_perception.LaneSegResult',              comm: 'cyber' },
      { topic: '/perception/rod_infer',                          proto: 'neo_perception.RodArray',                   comm: 'cyber' },
      { topic: '/pnc/prediction',                                proto: 'prediction.PredictionObstacles',            comm: 'cyber' },
      { topic: '/planning/proxy/DuDriveChassis',                 proto: 'status.Chassis',                            comm: 'cyber' },
      { topic: '/perception/static',                             proto: 'neo_perception.BevMap',                     comm: 'cyber' },
      { topic: '/perception/rod_output',                         proto: 'neo_perception.RodArray',                   comm: 'cyber' },
      { topic: '/maprouter/location',                            proto: 'map_engine.location.GpsLocationChangePub',  comm: 'cyber' },
      { topic: '/maprouter/guideinfo',                           proto: 'map_engine.guide.NaviInfoPub',              comm: 'cyber' },
      { topic: '/maprouter/navirouteinfo',                       proto: 'map_engine.naviroute.AMapCalcRouteResultPub', comm: 'cyber' },
      { topic: '/maprouter/maps',                                proto: 'neo_map.NeoMaps',                           comm: 'cyber' },
      { topic: '/state_machine/transition',                      proto: 'state_machine.GlobalStateMachine',           comm: 'cyber' },
      { topic: '/maprouter/dynamic_layer_on_path',               proto: 'DynamicLayer.DynamicLayersOnPath',          comm: 'cyber' },
      { topic: '/maprouter/routing_request',                     proto: 'openapild.routing.OpenApiRoutingRequest',   comm: 'cyber' },
      { topic: '/maprouter/adjusted_navi_request_info',          proto: 'neo_map.NaviRequestInfo',                   comm: 'cyber' },
    ],
  },
  {
    name: 'planning', domain: 'pnc', runtime: 'nexis_app', enabled: true,
    components: ['PlanningComponent'],
    pub: [
      { topic: '/planning/pilot_state', proto: 'planning.PilotState',       comm: 'cyber' },
      { topic: '/planning/trajectory',  proto: 'planning.ADCTrajectory',    comm: 'cyber', freq: '~20Hz' },
    ],
    sub: [
      { topic: '/neo_map_router/router_output',         proto: 'map_router.MapRouter',                 comm: 'cyber' },
      { topic: '/localization/100hz/localization_pose',  proto: 'localization.LocalizationEstimate',    comm: 'cyber' },
      { topic: '/planning/proxy/DuDriveChassis',        proto: 'status.Chassis',                       comm: 'cyber' },
      { topic: '/pnc/prediction',                       proto: 'prediction.PredictionObstacles',       comm: 'cyber' },
      { topic: '/state_machine/transition',             proto: 'state_machine.GlobalStateMachine',     comm: 'cyber' },
    ],
  },
  {
    name: 'control', domain: 'pnc', runtime: 'mainboard', enabled: true,
    components: ['ControlComponent'],
    pub: [
      { topic: '/pnc/control', proto: 'control.ControlCommand', comm: 'cyber', freq: '~100Hz' },
    ],
    sub: [
      { topic: '/planning/trajectory',                  proto: 'planning.ADCTrajectory',            comm: 'cyber' },
      { topic: '/localization/100hz/localization_pose',  proto: 'localization.LocalizationEstimate', comm: 'cyber' },
      { topic: '/planning/proxy/DuDriveChassis',        proto: 'status.Chassis',                    comm: 'cyber' },
    ],
  },
  {
    name: 'aeb', domain: 'pnc', runtime: 'mainboard', enabled: true,
    components: ['AebComponent'],
    pub: [
      { topic: '/aeb/aeb_cmd', proto: 'planning.AebCmd', comm: 'cyber' },
    ],
    sub: [
      { topic: '/localization/100hz/localization_pose', proto: 'localization.LocalizationEstimate', comm: 'cyber' },
      { topic: '/planning/proxy/DuDriveChassis',       proto: 'status.Chassis',                    comm: 'cyber' },
    ],
  },
  {
    name: 'state_machine', domain: 'system', runtime: 'mainboard', enabled: true,
    components: ['StateMachineComponent'],
    pub: [
      { topic: '/state_machine/transition', proto: 'state_machine.GlobalStateMachine', comm: 'cyber' },
    ],
    sub: [],
  },
  {
    name: 'dynamic_layer', domain: 'pnc', runtime: 'mainboard', enabled: true,
    components: ['DynamicLayerComponent'],
    pub: [
      { topic: '/maprouter/dynamic_layer_on_path', proto: 'DynamicLayer.DynamicLayersOnPath', comm: 'cyber' },
    ],
    sub: [],
  },
  {
    name: 'orin_ivi', domain: 'system', runtime: 'mainboard', enabled: true,
    components: ['OrinToIviReporter', 'MapEngineCyber'],
    pub: [
      { topic: '/maprouter/location',       proto: 'map_engine.location.GpsLocationChangePub',       comm: 'cyber' },
      { topic: '/maprouter/guideinfo',      proto: 'map_engine.guide.NaviInfoPub',                   comm: 'cyber' },
      { topic: '/maprouter/navirouteinfo',  proto: 'map_engine.naviroute.AMapCalcRouteResultPub',    comm: 'cyber' },
      { topic: '/maprouter/maps',           proto: 'neo_map.NeoMaps',                                comm: 'cyber' },
    ],
    sub: [
      { topic: '/localization/100hz/localization_vehicle_speed', proto: 'localization_dr.LocalizationVehicleSpeed', comm: 'cyber' },
    ],
  },
  {
    name: 'openapi', domain: 'system', runtime: 'mainboard', enabled: true,
    components: ['OpenapiComponent'],
    pub: [
      { topic: '/openapi/auto_driver_status',              proto: 'common.AutoDriverStatus',                    comm: 'cyber' },
      { topic: '/maprouter/routing_request',               proto: 'openapild.routing.OpenApiRoutingRequest',    comm: 'cyber' },
      { topic: '/maprouter/adjusted_navi_request_info',    proto: 'neo_map.NaviRequestInfo',                    comm: 'cyber' },
    ],
    sub: [],
  },
  {
    name: 'guardian_cyber', domain: 'system', runtime: 'mainboard', enabled: true,
    components: ['PatrolStrategy', 'PatrolSafetyMonitor'],
    pub: [
      { topic: '/patrol/discode', proto: 'patrol.DisCode', comm: 'cyber' },
    ],
    sub: [],
  },
  {
    name: 'system_monitor', domain: 'system', runtime: 'nexis_app', enabled: true,
    components: ['SystemMonitorComponent'],
    pub: [
      { topic: '/nexis/security/alarm/alarm_state_data', proto: 'alarm.AlarmStateDataList', comm: 'nexis', freq: '~20Hz' },
    ],
    sub: [],
  },
  {
    name: 'fault_manager', domain: 'system', runtime: 'nexis_app', enabled: true,
    components: ['FaultManagerExecutor'],
    pub: [
      { topic: '/nexis/security/alarm/fault_process', proto: 'alarm.FaultProcess', comm: 'nexis', freq: '~20Hz' },
    ],
    sub: [
      { topic: '/nexis/security/alarm/alarm_state_data', proto: 'alarm.AlarmStateDataList', comm: 'nexis' },
    ],
  },
  {
    name: 'mpu_monitor',      domain: 'system',   runtime: 'mainboard', enabled: true, components: ['CompMpuMonitor'], pub: [], sub: [] },
  {
    name: 'lidar_freespace',  domain: 'perception', runtime: 'mainboard', enabled: true, components: ['LidarModelExecutor'],
    pub: [],
    sub: [{ topic: '/sensor/lidar/top/pointcloud', proto: 'PointCloud', comm: 'cyber' }],
  },
  { name: 'tsp_client',       domain: 'system',   runtime: 'mainboard', enabled: true, components: ['TspComponent'], pub: [], sub: [] },
  { name: 'proto_recorder',   domain: 'recorder', runtime: 'mainboard', enabled: true, components: ['ProtoRecorderComponent'], pub: [], sub: [] },
  { name: 'camera_recorder',  domain: 'recorder', runtime: 'mainboard', enabled: true, components: ['CameraRecorderComponent'], pub: [], sub: [] },
  { name: 'lidar_recorder',   domain: 'recorder', runtime: 'mainboard', enabled: true, components: ['LidarRecorderComponent'], pub: [], sub: [] },
  { name: 'dcl',              domain: 'system',   runtime: 'mainboard', enabled: true, components: ['DclMgrComponent'], pub: [], sub: [] },
];

export function buildGraph() {
  const enabledProcs = PROCESSES.filter(p => p.enabled);

  const pubIndex = {};
  enabledProcs.forEach(p => {
    p.pub.forEach(c => {
      if (!pubIndex[c.topic]) pubIndex[c.topic] = [];
      pubIndex[c.topic].push({ proc: p.name, proto: c.proto, freq: c.freq || '' });
    });
  });

  const linkMap = {};
  enabledProcs.forEach(p => {
    p.sub.forEach(c => {
      const pubs = pubIndex[c.topic];
      if (!pubs) return;
      pubs.forEach(pub => {
        if (pub.proc === p.name) return;
        const key = `${pub.proc}\x00${p.name}`;
        if (!linkMap[key]) {
          linkMap[key] = { source: pub.proc, target: p.name, topics: [] };
        }
        linkMap[key].topics.push({
          topic: c.topic,
          proto: c.proto || pub.proto,
          freq: pub.freq,
        });
      });
    });
  });

  const nodes = enabledProcs.map(p => ({
    id: p.name,
    domain: p.domain,
    runtime: p.runtime,
    components: p.components,
    pubCount: p.pub.length,
    subCount: p.sub.length,
  }));

  const links = Object.values(linkMap);

  return { nodes, links };
}
