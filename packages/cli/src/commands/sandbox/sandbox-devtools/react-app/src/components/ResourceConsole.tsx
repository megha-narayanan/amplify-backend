import React, { useState, useMemo, useEffect } from 'react';
import { Socket } from 'socket.io-client';
import { useResourceManager, Resource } from './ResourceManager';
import { getAwsConsoleUrl, ResourceWithFriendlyName } from '../../../resource_console_functions';
import '@cloudscape-design/global-styles/index.css';
import {
  Button,
  Container,
  Header,
  Spinner,
  Table,
  TextContent,
  Box,
  SpaceBetween,
  ExpandableSection,
  StatusIndicator,
  Link,
  Input,
  FormField,
  Grid,
  Multiselect,
  SelectProps,
  Alert
} from '@cloudscape-design/components';

interface ResourceConsoleProps {
  socket: Socket | null;
  sandboxStatus?: 'running' | 'stopped' | 'nonexistent' | 'unknown' | 'deploying';
}

// Define column definitions type
type ColumnDefinition = {
  id: string;
  header: string;
  cell: (item: Resource) => React.ReactNode;
  width: number;
  minWidth: number;
};

const ResourceConsole: React.FC<ResourceConsoleProps> = ({ socket, sandboxStatus = 'unknown' }) => {
  const [lastRefreshTime, setLastRefreshTime] = useState<number>(0);
  const [deploymentInProgress, setDeploymentInProgress] = useState<boolean>(false);
  const [deploymentMessage, setDeploymentMessage] = useState<string>('');
  const [initializing, setInitializing] = useState<boolean>(true);
  const REFRESH_COOLDOWN_MS = 5000; // 5 seconds minimum between refreshes
  
  // Define column definitions for all tables
  const columnDefinitions = React.useMemo<ColumnDefinition[]>(() => [
    {
      id: 'name',
      header: 'Resource Name',
      cell: (item: Resource) => {
        return getFriendlyResourceName(item);
      },
      width: 600,
      minWidth: 200
    },
    {
      id: 'logicalId',
      header: 'Logical ID',
      cell: (item: Resource) => item.logicalResourceId,
      width: 600,
      minWidth: 200
    },
    {
      id: 'status',
      header: 'Status',
      cell: (item: Resource) => (
        <Box padding="s">
          <SpaceBetween direction="vertical" size="xs">
            <Box color="text-status-info" fontSize="body-m">
              {getStatusType(item.resourceStatus)}
            </Box>
          </SpaceBetween>
        </Box>
      ),
      width: 200,
      minWidth: 200
    },
    {
      id: 'physicalId',
      header: 'Physical ID',
      cell: (item: Resource) => item.physicalResourceId,
      width: 600,
      minWidth: 300
    },
    {
      id: 'console',
      header: 'AWS Console',
      cell: (item: Resource) => {
        const url = getAwsConsoleUrl(item as ResourceWithFriendlyName, region);
        
        return url ? (
          <Link href={url} external>
            View in AWS Console
          </Link>
        ) : (
          <span>Not available</span>
        );
      },
      width: 250,
      minWidth: 250
    }
  ], []);

  // Empty state for tables
  const emptyState = (
    <Box textAlign="center" padding="s">
      <SpaceBetween direction="vertical" size="xs">
        <TextContent>
          <p>No resources found</p>
        </TextContent>
      </SpaceBetween>
    </Box>
  );
  
  // Wrap refreshResources with rate limiting
  const { resources, loading, error, refreshResources: originalRefreshResources } = useResourceManager(socket, undefined, sandboxStatus);
  
  // Clear initializing state after a timeout or when resources are loaded
  useEffect(() => {
    const timer = setTimeout(() => {
      setInitializing(false);
    }, 3000); // Give it 3 seconds to initialize
    
    // If resources are loaded, clear initializing state immediately
    if (resources) {
      setInitializing(false);
    }
    
    return () => clearTimeout(timer);
  }, [resources]);
  
  // Listen for deployment in progress events
  useEffect(() => {
    if (!socket) return;
    
    const handleDeploymentInProgress = (data: { message: string }) => {
      console.log('ResourceConsole: Deployment in progress:', data.message);
      setDeploymentInProgress(true);
      setDeploymentMessage(data.message);
    };
    
    socket.on('deploymentInProgress', handleDeploymentInProgress);
    
    // Reset deployment in progress when resources are updated
    const handleResourcesUpdated = () => {
      console.log('ResourceConsole: Resources updated, clearing deployment status');
      setDeploymentInProgress(false);
      setDeploymentMessage('');
    };
    
    socket.on('deployedBackendResources', handleResourcesUpdated);
    
    // Add a safety timeout to reset deployment status if it gets stuck
    let deploymentTimeout: NodeJS.Timeout | null = null;
    
    if (deploymentInProgress) {
      deploymentTimeout = setTimeout(() => {
        console.log('ResourceConsole: Deployment status reset due to timeout');
        setDeploymentInProgress(false);
        setDeploymentMessage('');
        // Force refresh resources
        if (socket && socket.connected) {
          socket.emit('getDeployedBackendResources');
        }
      }, 60000); // 1 minute timeout
    }
    
    return () => {
      socket.off('deploymentInProgress', handleDeploymentInProgress);
      socket.off('deployedBackendResources', handleResourcesUpdated);
      if (deploymentTimeout) {
        clearTimeout(deploymentTimeout);
      }
    };
  }, [socket, deploymentInProgress]);
  
  // Update deployment status when sandbox status changes
  useEffect(() => {
    if (sandboxStatus === 'deploying') {
      setDeploymentInProgress(true);
      setDeploymentMessage('Sandbox is being deployed...');
    } else if (sandboxStatus === 'running') {
      // Only clear deployment status if we were previously deploying
      if (deploymentInProgress && deploymentMessage === 'Sandbox is being deployed...') {
        setDeploymentInProgress(false);
        setDeploymentMessage('');
      }
    }
  }, [sandboxStatus, deploymentInProgress, deploymentMessage]);
  
  const refreshResources = React.useCallback(() => {
    const now = Date.now();
    if (now - lastRefreshTime < REFRESH_COOLDOWN_MS) {
      console.log('ResourceConsole: Refresh cooldown in effect, skipping refresh');
      return;
    }
    
    console.log('ResourceConsole: Refreshing resources');
    originalRefreshResources();
    setLastRefreshTime(now);
  }, [originalRefreshResources, lastRefreshTime, REFRESH_COOLDOWN_MS]);
  
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedServiceTypes, setSelectedServiceTypes] = useState<readonly SelectProps.Option[]>([]);
  const [selectedStatuses, setSelectedStatuses] = useState<readonly SelectProps.Option[]>([]);

  // Extract all unique resource types and statuses for filter options
  const serviceTypeOptions = useMemo(() => {
    if (!resources?.resources) return [];
    
    const types = new Set<string>();
    resources.resources.forEach((resource: Resource) => {
      if (resource.resourceType !== 'AWS::CDK::Metadata') {
        types.add(resource.resourceType);
      }
    });
    
    return Array.from(types).map(type => ({ label: type, value: type }));
  }, [resources]);

  const statusOptions = useMemo(() => {
    if (!resources?.resources) return [];
    
    const statuses = new Set<string>();
    resources.resources.forEach((resource: Resource) => {
      statuses.add(resource.resourceStatus);
    });
    
    return Array.from(statuses).map(status => ({ label: status, value: status }));
  }, [resources]);

  // Extract service name from resource type (e.g., "Lambda" from "AWS::Lambda::Function")
  const getServiceName = (resourceType: string): string => {
    const parts = resourceType.split('::');
    return parts.length >= 2 ? parts[1] : resourceType;
  };

  // Get a friendly resource type name without the AWS:: prefix
  const getFriendlyResourceType = (resourceType: string): string => {
    const parts = resourceType.split('::');
    if (parts.length == 3) {
      return `${parts[1]} ${parts[2]}`;
    }
    else if (parts.length > 3) {
      return `${parts[1]} ${parts[2]} ${parts[3]}`;
    }
    return resourceType;
  };

  // Get a friendly name for a resource based on its friendlyName property or logical ID
  const getFriendlyResourceName = (resource: Resource): string => {
    // If the resource has a friendlyName property, use it
    if (resource.friendlyName) {
      return resource.friendlyName;
    }
    // Otherwise, fall back to the logical ID
    return resource.logicalResourceId;
  };

  // Filter resources based on search query and selected filters
  const filteredResources = useMemo(() => {
    if (!resources?.resources) return [];
    
    return resources.resources.filter((resource: Resource) => {
      // Filter out CDK metadata
      if (resource.resourceType === 'AWS::CDK::Metadata') return false;
      
      // Apply search filter
      const searchLower = searchQuery.toLowerCase();
      const matchesSearch = searchQuery === '' || 
        resource.logicalResourceId.toLowerCase().includes(searchLower) ||
        resource.physicalResourceId.toLowerCase().includes(searchLower) ||
        getFriendlyResourceName(resource).toLowerCase().includes(searchLower) ||
        resource.resourceType.toLowerCase().includes(searchLower);
      
      const matchesServiceType = selectedServiceTypes.length === 0 || 
        selectedServiceTypes.some(option => option.value === resource.resourceType);
      
      const matchesStatus = selectedStatuses.length === 0 || 
        selectedStatuses.some(option => option.value === resource.resourceStatus);
      
      return matchesSearch && matchesServiceType && matchesStatus;
    });
  }, [resources, searchQuery, selectedServiceTypes, selectedStatuses]);

  // Group filtered resources by service and then by resource type
  const groupedResources = useMemo(() => {
    const serviceGroups: Record<string, Record<string, Resource[]>> = {};
    
    filteredResources.forEach((resource: Resource) => {
      const service = getServiceName(resource.resourceType);
      const resourceType = getFriendlyResourceType(resource.resourceType);
      
      if (!serviceGroups[service]) {
        serviceGroups[service] = {};
      }
      
      if (!serviceGroups[service][resourceType]) {
        serviceGroups[service][resourceType] = [];
      }
      
      serviceGroups[service][resourceType].push(resource);
    });
    
    return serviceGroups;
  }, [filteredResources]);

  const getStatusType = (status: string): 'Deployed' | 'Failed' | 'Deleted' | 'Deleting' | 'Deploying' | 'Unknown' => {
    if (status.includes('DEPLOYED')) return 'Deployed';
    if (status.includes('FAILED')) return 'Failed';
    if (status.includes('DELETED')) return 'Deleted';
    if (status.includes('DELETING')) return 'Deleting';
    if (status.includes('DEPLOYING')) return 'Deploying';
    return 'Unknown'; // Default for unknown status types
  };

  // Get the AWS region from the resources data
  const region = useMemo(() => {
    return resources?.region || null;
  }, [resources]);

  const regionAvailable = region !== null;

  // Check for nonexistent sandbox first, before showing loading spinner
  if (sandboxStatus === 'nonexistent') {
    return (
      <Container>
        <SpaceBetween direction="vertical" size="m">
          <Box textAlign="center" padding="l">
            <StatusIndicator type="error">No sandbox exists</StatusIndicator>
            <TextContent>
              <p>You need to create a sandbox first. Use the Start Sandbox button in the header.</p>
            </TextContent>
          </Box>
        </SpaceBetween>
      </Container>
    );
  }

  // Show loading spinner during initialization or when loading resources for the first time
  if ((initializing || (loading && (!resources || !resources.resources || resources.resources.length === 0))) && !deploymentInProgress) {
    return (
      <Container>
        <SpaceBetween direction="vertical" size="m">
          <Box textAlign="center" padding="l">
            <Spinner size="large" />
            <TextContent>
              <p>{initializing ? 'Initializing DevTools and loading resources...' : 'Loading resources...'}</p>
            </TextContent>
          </Box>
        </SpaceBetween>
      </Container>
    );
  }

  if (sandboxStatus === 'stopped') {
    // For stopped state, show a warning banner but still display resources
    return (
      <Container>
        <SpaceBetween direction="vertical" size="m">
          <Box textAlign="center" padding="l">
            <StatusIndicator type="warning">Sandbox is stopped</StatusIndicator>
            <TextContent>
              <p>The sandbox is currently stopped. Use the Start Sandbox button in the header to start it.</p>
              <p>Showing resources from the most recent deployment.</p>
            </TextContent>
            <Button onClick={refreshResources}>Refresh Resources</Button>
          </Box>
          
          {/* Continue to show resources even when stopped */}
          {!loading && resources && Object.keys(groupedResources).length > 0 && (
            <ResourceDisplay 
              groupedResources={groupedResources}
              columnDefinitions={columnDefinitions}
              emptyState={emptyState}
              refreshResources={refreshResources}
              regionAvailable={regionAvailable}
            />
          )}
        </SpaceBetween>
      </Container>
    );
  }
  
  if (sandboxStatus === 'deploying' || deploymentInProgress) {
    // Show a loading state but still display resources if available
    return (
      <Container>
        <SpaceBetween direction="vertical" size="m">
          <Box textAlign="center" padding="l">
            <StatusIndicator type="in-progress">Sandbox is deploying</StatusIndicator>
            <TextContent>
              <p>The sandbox is currently being deployed. This may take a few minutes.</p>
              {deploymentMessage && <p>{deploymentMessage}</p>}
              {resources && resources.resources && resources.resources.length > 0 && (
                <p>Showing resources from the previous deployment.</p>
              )}
            </TextContent>
            <Button onClick={refreshResources}>Refresh Resources</Button>
          </Box>
          
          {/* Show resources if available, even during deployment */}
          {resources && resources.resources && resources.resources.length > 0 && (
            <ResourceDisplay 
              groupedResources={groupedResources}
              columnDefinitions={columnDefinitions}
              emptyState={emptyState}
              refreshResources={refreshResources}
              regionAvailable={regionAvailable}
            />
          )}
        </SpaceBetween>
      </Container>
    );
  }

  if (error) {
    return (
      <Container>
        <SpaceBetween direction="vertical" size="m">
          <Box textAlign="center" padding="l">
            <StatusIndicator type="error">Error: {error}</StatusIndicator>
            <Button onClick={refreshResources}>Retry</Button>
          </Box>
        </SpaceBetween>
      </Container>
    );
  }

  if (!resources || Object.keys(groupedResources).length === 0) {
    return (
      <Container>
        <SpaceBetween direction="vertical" size="m">
          <Box textAlign="center" padding="l">
            <TextContent>
              <p>No resources found.</p>
            </TextContent>
            <Button onClick={refreshResources}>Refresh</Button>
          </Box>
        </SpaceBetween>
      </Container>
    );
  }

  return (
    <Container
      disableContentPaddings={false}
      variant="default"
      fitHeight
    >
      <SpaceBetween direction="vertical" size="l">
        <Header
          variant="h1"
          actions={
            <Button onClick={refreshResources} iconName="refresh">
              Refresh
            </Button>
          }
        >
          Deployed Resources
        </Header>
        
        {deploymentInProgress && (
          <Alert type="info" header="Deployment in progress">
            {deploymentMessage || 'Sandbox deployment is in progress. Resources will update when deployment completes.'}
          </Alert>
        )}
        
        {!regionAvailable && (
          <StatusIndicator type="warning">
            AWS region could not be detected. Console links are unavailable.
          </StatusIndicator>
        )}

        <Grid gridDefinition={[{ colspan: 12 }]}>
          <SpaceBetween direction="vertical" size="s">
            <FormField label="Search resources">
              <Input
                value={searchQuery}
                onChange={({ detail }) => setSearchQuery(detail.value)}
                placeholder="Search by ID, type, or status..."
              />
            </FormField>
            
            <Grid gridDefinition={[{ colspan: 6 }, { colspan: 6 }]}>
              <FormField label="Filter by service type">
                <Multiselect
                  selectedOptions={selectedServiceTypes}
                  onChange={({ detail }) => setSelectedServiceTypes(detail.selectedOptions)}
                  options={serviceTypeOptions}
                  placeholder="Select service types"
                  filteringType="auto"
                />
              </FormField>
              
              <FormField label="Filter by deployment status">
                <Multiselect
                  selectedOptions={selectedStatuses}
                  onChange={({ detail }) => setSelectedStatuses(detail.selectedOptions)}
                  options={statusOptions}
                  placeholder="Select statuses"
                  filteringType="auto"
                />
              </FormField>
            </Grid>
          </SpaceBetween>
        </Grid>
        
        {Object.entries(groupedResources).map(([serviceName, resourceTypes]) => (
          <ExpandableSection 
            key={serviceName} 
            headerText={serviceName}
            defaultExpanded
          >
            <SpaceBetween direction="vertical" size="s">
              {Object.entries(resourceTypes).map(([resourceType, resources]) => (
                <ExpandableSection 
                  key={`${serviceName}-${resourceType}`} 
                  headerText={resourceType}
                  variant="container"
                >
                  <Table
                    columnDefinitions={columnDefinitions}
                    items={resources}
                    loadingText="Loading resources"
                    trackBy="logicalResourceId"
                    empty={emptyState}
                    resizableColumns
                    stickyHeader
                    wrapLines
                  />
                </ExpandableSection>
              ))}
            </SpaceBetween>
          </ExpandableSection>
        ))}
      </SpaceBetween>
    </Container>
  );
};

// Helper component to display resources
interface ResourceDisplayProps {
  groupedResources: Record<string, Record<string, Resource[]>>;
  columnDefinitions: ColumnDefinition[];
  emptyState: React.ReactNode;
  refreshResources: () => void;
  regionAvailable: boolean;
}

const ResourceDisplay: React.FC<ResourceDisplayProps> = ({ 
  groupedResources, 
  columnDefinitions, 
  emptyState, 
  refreshResources,
  regionAvailable
}) => {
  return (
    <SpaceBetween direction="vertical" size="l">
      <Header
        variant="h1"
        actions={
          <Button onClick={refreshResources} iconName="refresh">
            Refresh
          </Button>
        }
      >
        Deployed Resources
      </Header>
      
      {!regionAvailable && (
        <StatusIndicator type="warning">
          AWS region could not be detected. Console links are unavailable.
        </StatusIndicator>
      )}

      {Object.entries(groupedResources).map(([serviceName, resourceTypes]) => (
        <ExpandableSection 
          key={serviceName} 
          headerText={serviceName}
          defaultExpanded
        >
          <SpaceBetween direction="vertical" size="s">
            {Object.entries(resourceTypes).map(([resourceType, resources]) => (
              <ExpandableSection 
                key={`${serviceName}-${resourceType}`} 
                headerText={resourceType}
                variant="container"
              >
                <Table
                  columnDefinitions={columnDefinitions}
                  items={resources}
                  loadingText="Loading resources"
                  trackBy="logicalResourceId"
                  empty={emptyState}
                  resizableColumns
                  stickyHeader
                  wrapLines
                />
              </ExpandableSection>
            ))}
          </SpaceBetween>
        </ExpandableSection>
      ))}
    </SpaceBetween>
  );
};

export default ResourceConsole;
