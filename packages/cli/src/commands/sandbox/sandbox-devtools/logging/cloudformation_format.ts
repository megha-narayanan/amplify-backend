/**
 * Creates a friendly name for a resource, using CDK metadata when available.
 * @param logicalId The logical ID of the resource
 * @param metadata Optional CDK metadata that may contain construct path
 * @param metadata.constructPath Optional construct path from CDK metadata
 * @returns A user-friendly name for the resource
 */
export const createFriendlyName = (
  logicalId: string,
  metadata?: { constructPath?: string },
): string => {
  // If we have CDK metadata with a construct path, use it
  if (metadata?.constructPath) {
    return normalizeCDKConstructPath(metadata.constructPath);
  }

  // For CloudFormation stacks, try to extract a friendly name
  if (
    logicalId.includes('NestedStack') ||
    logicalId.endsWith('StackResource')
  ) {
    const nestedStackName = getFriendlyNameFromNestedStackName(logicalId);
    if (nestedStackName) {
      return nestedStackName;
    }
  }

  // Fall back to the basic transformation
  let name = logicalId.replace(/^amplify/, '').replace(/^Amplify/, '');
  name = name.replace(/([A-Z])/g, ' $1').trim();
  name = name.replace(/[0-9]+[A-Z]*[0-9]*/, '');

  return name || logicalId;
};

/**
 * Normalizes a CDK construct path to create a more readable friendly name
 * @param constructPath The CDK construct path
 * @returns A normalized construct path
 */
const normalizeCDKConstructPath = (constructPath: string): string => {
  // Don't process very long paths to avoid performance issues
  if (constructPath.length > 1000) return constructPath;

  // Handle nested stack paths
  const nestedStackRegex =
    /(?<nestedStack>[a-zA-Z0-9_]+)\.NestedStack\/\1\.NestedStackResource$/;

  return constructPath
    .replace(nestedStackRegex, '$<nestedStack>')
    .replace('/amplifyAuth/', '/')
    .replace('/amplifyData/', '/');
};

/**
 * Extracts a friendly name from a nested stack logical ID
 * @param stackName The stack name to process
 * @returns A friendly name or undefined if no match
 */
const getFriendlyNameFromNestedStackName = (
  stackName: string,
): string | undefined => {
  const parts = stackName.split('-');

  if (parts && parts.length === 7 && parts[3] === 'sandbox') {
    return parts[5].slice(0, -10) + ' stack';
  } else if (parts && parts.length === 5 && parts[3] === 'sandbox') {
    return 'root stack';
  }

  return undefined;
};

/**
 * Clean ANSI escape codes from text
 * @param text The text to clean
 * @returns The cleaned text
 */
export const cleanAnsiCodes = (text: string): string => {
  // Split the regex into parts to avoid control characters
  const ansiEscapeCodesPattern = new RegExp(
    [
      // ESC [ n ; n ; ... m
      String.fromCharCode(27) + '\\[\\d+(?:;\\d+)*m',
      // Other common ANSI sequences
      '\\[2m',
      '\\[22m',
      '\\[1m',
      '\\[36m',
      '\\[39m',
    ].join('|'),
    'g',
  );

  return text.replace(ansiEscapeCodesPattern, '');
};

/**
 * Check if a line matches CloudFormation event patterns
 * @param cleanLine The cleaned line to check
 * @returns True if the line matches any CloudFormation pattern
 */
const matchesCloudFormationPattern = (cleanLine: string): boolean => {
  const originalMatch = /\s+[AP]M\s+\|\s+[A-Z_]+\s+\|\s+.+\s+\|\s+.+/.test(
    cleanLine,
  );
  const actualMatch =
    /\d+:\d+:\d+\s+[AP]M.*?\|\s*\d+\s*\|\s*\d+:\d+:\d+\s+[AP]M\s*\|\s*[A-Z_]+\s*\|\s*.*?\s*\|\s*.*/.test(
      cleanLine,
    );
  const simpleMatch = /\|\s*[A-Z_]+\s*\|\s*AWS::[A-Za-z0-9:]+/.test(cleanLine);
  const hasDeploymentKeywords =
    cleanLine.includes('_IN_PROGRESS') ||
    cleanLine.includes('CREATE_') ||
    cleanLine.includes('DELETE_') ||
    cleanLine.includes('UPDATE_') ||
    cleanLine.includes('COMPLETE') ||
    cleanLine.includes('FAILED');
  return (
    originalMatch ||
    actualMatch ||
    simpleMatch ||
    (hasDeploymentKeywords && cleanLine.includes('|'))
  );
};

/**
 * Check if a message is a deployment progress message
 * @param message The message to check
 * @returns True if the message is a deployment progress message
 */
export const isDeploymentProgressMessage = (message: string): boolean => {
  const cleanedMessage = cleanAnsiCodes(message);
  return (
    matchesCloudFormationPattern(cleanedMessage) ||
    cleanedMessage.includes('Deployment in progress')
  );
};

/**
 * Extract CloudFormation events from a message
 * @param message The message to extract events from
 * @returns An array of CloudFormation events
 */
export const extractCloudFormationEvents = (message: string): string[] => {
  const events: string[] = [];
  const lines = message.split('\n');

  for (const line of lines) {
    const cleanLine = cleanAnsiCodes(line);
    if (matchesCloudFormationPattern(cleanLine)) {
      events.push(line);
    }
  }

  return events;
};

/**
 * Type for parsed CloudFormation resource status
 */
export type ResourceStatus = {
  resourceType: string;
  resourceName: string;
  status: string;
  timestamp: string;
  key: string;
};

/**
 * Parse a deployment message to extract structured information
 * @param message The message to parse
 * @returns A ResourceStatus object or null if the message doesn't match the expected format
 */
export const parseDeploymentMessage = (
  message: string,
): ResourceStatus | null => {
  const cfnMatch = message.match(
    /(\d+:\d+:\d+\s+[AP]M)\s+\|\s+([A-Z_]+)\s+\|\s+([^|]+)\s+\|\s+(.+)/,
  );
  if (cfnMatch) {
    const timestamp = cfnMatch[1].trim();
    const status = cfnMatch[2].trim();
    const resourceType = cfnMatch[3].trim();
    const resourceName = cfnMatch[4].trim();

    // Create a unique key for this resource
    const key = `${resourceType}:${resourceName}`;

    return {
      resourceType,
      resourceName,
      status,
      timestamp,
      key,
    };
  }

  return null;
};
