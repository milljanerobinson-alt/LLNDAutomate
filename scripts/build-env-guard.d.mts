import type { Plugin } from 'vite';
export interface EnvironmentsConfig { productionBranch: string; production: string[]; preview: string[]; protected: string[] }
export type BuildTargetResult = { ok: true; kind: 'local' | 'production' | 'preview'; ref: string | null } | { ok: false; reason: string };
export function loadEnvironments(path?: string): EnvironmentsConfig;
export function projectRef(url: string | undefined | null): string | null;
export function checkBuildTarget(env: Record<string, string | undefined>, cfg: EnvironmentsConfig): BuildTargetResult;
export function buildEnvGuard(): Plugin;
