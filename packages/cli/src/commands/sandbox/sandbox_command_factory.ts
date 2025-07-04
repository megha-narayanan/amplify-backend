import { CommandModule } from 'yargs';
import { fileURLToPath } from 'node:url';
import {
  SandboxCommand,
  SandboxCommandOptionsKebabCase,
} from './sandbox_command.js';
import { SandboxSingletonFactory } from '@aws-amplify/sandbox';
import { SandboxDeleteCommand } from './sandbox-delete/sandbox_delete_command.js';
import { SandboxSeedCommand } from './sandbox-seed/sandbox_seed_command.js';
import { SandboxDevToolsCommandFactory } from './sandbox-devtools/sandbox_devtools_command_factory.js';
import { SandboxBackendIdResolver } from './sandbox_id_resolver.js';
import { ClientConfigGeneratorAdapter } from '../../client-config/client_config_generator_adapter.js';
import { LocalNamespaceResolver } from '../../backend-identifier/local_namespace_resolver.js';
import { createSandboxSecretCommand } from './sandbox-secret/sandbox_secret_command_factory.js';
import {
  PackageJsonReader,
  UsageDataEmitterFactory,
} from '@aws-amplify/platform-core';
import { SandboxEventHandlerFactory } from './sandbox_event_handler_factory.js';
import { CommandMiddleware } from '../../command_middleware.js';
import {
  PackageManagerControllerFactory,
  format,
  printer,
} from '@aws-amplify/cli-core';
import { S3Client } from '@aws-sdk/client-s3';
import { AmplifyClient } from '@aws-sdk/client-amplify';
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { NoticesRenderer } from '../../notices/notices_renderer.js';
import { SandboxSeedGeneratePolicyCommand } from './sandbox-seed/sandbox_seed_policy_command.js';
import { SDKProfileResolverProvider } from '../../sdk_profile_resolver_provider.js';

/**
 * Creates wired sandbox command.
 */
export const createSandboxCommand = (
  noticesRenderer: NoticesRenderer,
): CommandModule<object, SandboxCommandOptionsKebabCase> => {
  const sandboxBackendIdPartsResolver = new SandboxBackendIdResolver(
    new LocalNamespaceResolver(new PackageJsonReader()),
  );

  const sandboxFactory = new SandboxSingletonFactory(
    sandboxBackendIdPartsResolver.resolve,
    new SDKProfileResolverProvider().resolve,
    printer,
    format,
  );
  const s3Client = new S3Client();
  const amplifyClient = new AmplifyClient();
  const cloudFormationClient = new CloudFormationClient();

  const awsClientProvider = {
    getS3Client: () => s3Client,
    getAmplifyClient: () => amplifyClient,
    getCloudFormationClient: () => cloudFormationClient,
  };
  const clientConfigGeneratorAdapter = new ClientConfigGeneratorAdapter(
    awsClientProvider,
  );

  const libraryVersion =
    new PackageJsonReader().read(
      fileURLToPath(new URL('../../../package.json', import.meta.url)),
    ).version ?? '';

  const eventHandlerFactory = new SandboxEventHandlerFactory(
    sandboxBackendIdPartsResolver.resolve,
    async () => {
      const dependencies = await new PackageManagerControllerFactory()
        .getPackageManagerController()
        .tryGetDependencies();
      return await new UsageDataEmitterFactory().getInstance(
        libraryVersion,
        dependencies,
      );
    },
    noticesRenderer,
  );

  const commandMiddleWare = new CommandMiddleware(printer);
  return new SandboxCommand(
    sandboxFactory,
    [
      new SandboxDeleteCommand(sandboxFactory),
      createSandboxSecretCommand(),
      new SandboxSeedCommand(sandboxBackendIdPartsResolver, [
        new SandboxSeedGeneratePolicyCommand(sandboxBackendIdPartsResolver),
      ]),
      new SandboxDevToolsCommandFactory().create(),
    ],
    clientConfigGeneratorAdapter,
    commandMiddleWare,
    eventHandlerFactory.getSandboxEventHandlers,
  );
};
