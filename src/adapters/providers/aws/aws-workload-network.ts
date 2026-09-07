import { z } from 'zod';
import type { Environment } from '../../../domain/entities/environment.entity.js';

export const AWS_WORKLOAD_NETWORK_BINDING = 'awsNetwork';
export const AWS_MANAGED_BY_TAG = 'managed-by';
export const AWS_ENVIRONMENT_ID_TAG = 'hypervibe-environment-id';
export const AWS_CLUSTER_ARN_TAG = 'hypervibe-ecs-cluster-arn';

const workloadNetworkSchema = z.object({
  accountId: z.string().regex(/^\d{12}$/),
  region: z.string().min(1),
  vpcId: z.string().min(1),
  subnetIds: z.array(z.string().min(1)).min(2),
  workloadSecurityGroupId: z.string().min(1),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.subnetIds).size !== value.subnetIds.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['subnetIds'],
      message: 'AWS workload-network subnet IDs must be unique',
    });
  }
});

export type AwsWorkloadNetwork = z.infer<typeof workloadNetworkSchema>;

export function parseEcsClusterArn(value: string): {
  accountId: string;
  region: string;
  clusterName: string;
} {
  const match = value.match(
    /^arn:aws(?:-[a-z]+)?:ecs:([^:]+):(\d{12}):cluster\/([A-Za-z0-9_-]+)$/
  );
  if (!match) throw new Error(`Invalid ECS cluster ARN: ${value}`);
  return { region: match[1]!, accountId: match[2]!, clusterName: match[3]! };
}

export function workloadSecurityGroupName(clusterName: string): string {
  return `${clusterName.slice(0, 230)}-hypervibe-workloads`;
}

export function workloadSecurityGroupTags(
  environmentId: string,
  clusterArn: string
): Array<{ Key: string; Value: string }> {
  return [
    { Key: AWS_MANAGED_BY_TAG, Value: 'hypervibe' },
    { Key: AWS_ENVIRONMENT_ID_TAG, Value: environmentId },
    { Key: AWS_CLUSTER_ARN_TAG, Value: clusterArn },
  ];
}

export function hasWorkloadSecurityGroupTags(
  tags: Array<{ Key?: string; Value?: string }> | undefined,
  clusterArn: string,
  environmentId?: string
): boolean {
  const values = new Map((tags ?? []).map((tag) => [tag.Key, tag.Value]));
  return values.get(AWS_MANAGED_BY_TAG) === 'hypervibe'
    && values.get(AWS_CLUSTER_ARN_TAG) === clusterArn
    && (!environmentId || values.get(AWS_ENVIRONMENT_ID_TAG) === environmentId);
}

export function parseAwsWorkloadNetworkBinding(
  environment: Pick<Environment, 'platformBindings'>
): AwsWorkloadNetwork | undefined {
  const raw = (environment.platformBindings as Record<string, unknown>)[AWS_WORKLOAD_NETWORK_BINDING];
  if (raw === undefined) return undefined;
  const parsed = workloadNetworkSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      'The persisted AWS workload-network binding is malformed; re-run hv_plan and reconcile the explicit AWS project action before mutating services or caches.'
    );
  }
  return {
    ...parsed.data,
    subnetIds: [...parsed.data.subnetIds].sort(),
  };
}

export function workloadNetworksMatch(
  left: AwsWorkloadNetwork,
  right: AwsWorkloadNetwork
): boolean {
  return left.accountId === right.accountId
    && left.region === right.region
    && left.vpcId === right.vpcId
    && left.workloadSecurityGroupId === right.workloadSecurityGroupId
    && JSON.stringify([...left.subnetIds].sort()) === JSON.stringify([...right.subnetIds].sort());
}
