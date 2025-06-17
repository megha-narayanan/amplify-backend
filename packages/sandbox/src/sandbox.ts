// EventEmitter is a class name and expected to have PascalCase
// eslint-disable-next-line @typescript-eslint/naming-convention
import EventEmitter from 'events';
import { ClientConfigFormat } from '@aws-amplify/client-config';
import { BackendIdentifier } from '@aws-amplify/plugin-types';
import { SandboxStateManager } from './sandbox_state_manager.js';

/**
 * Enum for sandbox status
 */
export enum SandboxStatus {
  RUNNING = 'running',
  STOPPED = 'stopped',
  NONEXISTENT = 'nonexistent'
}

/**
 * Interface for Sandbox.
 */
export type Sandbox = {
  /**
   * Starts the sandbox
   * @param options - such as which directory to watch for file changes
   */
  start: (options: SandboxOptions) => Promise<void>;

  /**
   * Stops watching for file changes
   */
  stop: () => Promise<void>;

  /**
   * Deletes this environment
   */
  delete: (options: SandboxDeleteOptions) => Promise<void>;

  /**
   * Gets the current status of the sandbox
   * @returns The current status of the sandbox (running, stopped, or nonexistent)
   */
  getStatus: () => Promise<SandboxStatus>;
  
  /**
   * Gets the state manager for this sandbox
   * @returns The state manager for this sandbox
   */
  getStateManager: () => SandboxStateManager;
} & EventEmitter;

export type SandboxEvents =
  | 'successfulDeployment'
  | 'failedDeployment'
  | 'successfulDeletion';

export type SandboxOptions = {
  dir?: string;
  exclude?: string[];
  identifier?: string;
  format?: ClientConfigFormat;
  watchForChanges?: boolean;
  functionStreamingOptions?: SandboxFunctionStreamingOptions;
};

export type SandboxFunctionStreamingOptions = {
  enabled: boolean;
  logsFilters?: string[];
  logsOutFile?: string;
};

export type SandboxDeleteOptions = {
  identifier?: string;
};
export type BackendIdSandboxResolver = (
  identifier?: string,
) => Promise<BackendIdentifier>;
