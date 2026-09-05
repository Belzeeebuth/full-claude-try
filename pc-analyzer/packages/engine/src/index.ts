export * from './types.js';
export { compareVersions, satisfiesMin, maxVersion, parseVersion } from './version.js';
export {
  evaluateLinuxCompatibility,
  badgeOf,
  worstStatus,
  ROLE_WEIGHTS,
  STATUS_SCORE,
  GREEN_THRESHOLD,
  MINOR_WEIGHT,
  UNKNOWN_CONFIDENCE,
  type LinuxCompatibilityReport,
  type ComponentVerdict,
  type EvaluateOptions,
} from './linux/compatibility.js';
export {
  recommendDistros,
  DEFAULT_PROFILE,
  HARDWARE_WEIGHT,
  type DistroRecommendation,
} from './linux/distro-recommender.js';
export {
  estimateFps,
  estimateFpsCatalog,
  playabilityOf,
  softMin,
  uncapReference,
  pickReference,
  LINUX_PICK_CONSTRAINTS,
  type PickConstraints,
  vendorKey,
  DEFAULT_PERF_MODEL,
  type PerfModel,
  type FpsEstimate,
  type OsFpsResult,
  type EstimateOptions,
  type Playability,
  type Bottleneck,
} from './performance/fps-estimator.js';
export {
  estimateProWorkloads,
  COMPUTE_EFFICIENCY,
  type WorkloadEstimate,
  type Workload,
} from './performance/pro-workloads.js';
