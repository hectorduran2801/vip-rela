import type { TestProject } from 'vitest/node';
import { buildTemplate, startCluster, type Cluster } from './pg-cluster.js';

let cluster: Cluster | undefined;

export default async function setup(project: TestProject) {
  cluster = startCluster();
  await buildTemplate(cluster);
  project.provide('pgCluster', { socketDir: cluster.socketDir, port: cluster.port });
  return () => cluster?.stop();
}

declare module 'vitest' {
  export interface ProvidedContext { pgCluster: { socketDir: string; port: number } }
}
