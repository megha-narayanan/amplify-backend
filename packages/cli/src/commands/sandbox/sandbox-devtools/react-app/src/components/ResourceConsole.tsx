import React, { useState, useMemo, useEffect } from 'react';
import { Socket } from 'socket.io-client';
import { useResourceManager, Resource } from './ResourceManager';
import { getAwsConsoleUrl, ResourceWithFriendlyName } from '../../../resource_console_functions';
import ResourceLogPanel from './ResourceLogPanel';
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
  Badge
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
  const deploymentInProgress = sandboxStatus === 'deploying';
  const [initializing, setInitializing] = useState<boolean>(true);
  const [activeLogStreams, setActiveLogStreams] = useState<string[]>([]);
  const [selectedLogResource, setSelectedLogResource] = useState<Resource | null>(null);
  const [showLogViewer, setShowLogViewer] = useState<boolean>(false);
  // Removed unused logEntries state
  const REFRESH_COOLDOWN_MS = 5000; // 5 seconds minimum between refreshes
  
  // Helper function to check if a resource supports logs
  const supportsLogs = (resource: Resource): boolean => {
    return (
      resource.resourceType === 'AWS::Lambda::Function' ||
      resource.resourceType === 'AWS::ApiGateway::RestApi' ||
      resource.resourceType === 'AWS::AppSync::GraphQLApi'
    );
  };

  // Wrap refreshResources with rate limiting
  const { resources, loading, error, refreshResources: originalRefreshResources } = useResourceManager(socket, undefined, sandboxStatus);
  
  // Get the AWS region from the resources data - Moved before columnDefinitions
  const region = useMemo(() => {
    return resources?.region || null;
  }, [resources]);

  // Define column definitions for all tables
  const columnDefinitions = React.useMemo<ColumnDefinition[]>(() => [
    {
      id: 'name',
      header: 'Resource Name',
      cell: (item: Resource) => {
        const isLogging = activeLogStreams.includes(item.physicalResourceId);
        return (
          <SpaceBetween direction="horizontal" size="xs">
            {getFriendlyResourceName(item)}
            {isLogging && <Badge color="green">Logging</Badge>}
          </SpaceBetween>
        );
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
      id: 'actions',
      header: 'Actions',
      cell: (item: Resource) => {
        const url = getAwsConsoleUrl(item as ResourceWithFriendlyName, region);
        const isLogging = activeLogStreams.includes(item.physicalResourceId);
        
        return (
          <SpaceBetween direction="horizontal" size="xs">
            {url && (
              <Link href={url} external>
                View in AWS Console
              </Link>
            )}
            {supportsLogs(item) && (
              <SpaceBetween direction="horizontal" size="xs">
                {/* Toggle button for starting/stopping log recording */}
                <Button 
                  variant="link" 
                  onClick={() => {
                    if (isLogging) {
                      // Stop recording logs
                      if (socket) {
                        socket.emit('toggleResourceLogging', { 
                          resourceId: item.physicalResourceId,
                          resourceType: item.resourceType,
                          startLogging: false
                        });
                      }
                    } else {
                      // Start recording logs
                      if (socket) {
                        socket.emit('toggleResourceLogging', { 
                          resourceId: item.physicalResourceId,
                          resourceType: item.resourceType,
                          startLogging: true
                        });
                      }
                    }
                  }}
                  disabled={!!(showLogViewer && selectedLogResource && selectedLogResource.physicalResourceId === item.physicalResourceId)}
                >
                  {isLogging ? "Stop Logs" : "Start Logs"}
                </Button>
                
                {/* Separate button for viewing logs */}
                <Button 
                  variant="link" 
                  onClick={() => {
                    // View logs without starting/stopping recording
                    if (socket) {
                      socket.emit('viewResourceLogs', { 
                        resourceId: item.physicalResourceId
                      });
                    }
                    setSelectedLogResource(item);
                    setShowLogViewer(true);
                  }}
                >
                  View Logs
                </Button>
              </SpaceBetween>
            )}
          </SpaceBetween>
        );
      },
      width: 250,
      minWidth: 250
    }
  ], [activeLogStreams, region, selectedLogResource]);

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
  
  // Listen for deployment messages
  useEffect(() => {
    if (!socket) return;
    
  //   const handleDeploymentInProgress = (data: { message: string }) => {
  //     console.log('ResourceConsole: Deployment in progress:', data.message);
  //     setDeploymentMessage(data.message);
  //   };
    
    // socket.on('deploymentInProgress', handleDeploymentInProgress);
    
    // Get active log streams on initial load
    socket.emit('getActiveLogStreams');
    
    // Handle active log streams
    const handleActiveLogStreams = (streams: string[]) => {
      console.log('ResourceConsole: Active log streams:', streams);
      setActiveLogStreams(streams);
    };
    
    // Handle log stream status updates
    const handleLogStreamStatus = (data: { resourceId: string, status: string, error?: string }) => {
      console.log(`ResourceConsole: Log stream status for ${data.resourceId}: ${data.status}`);
      
      if (data.status === 'active' || data.status === 'already-active') {
        setActiveLogStreams(prev => {
          if (!prev.includes(data.resourceId)) {
            return [...prev, data.resourceId];
          }
          return prev;
        });
      } else if (data.status === 'stopped') {
        setActiveLogStreams(prev => prev.filter(id => id !== data.resourceId));
      } else if (data.status === 'error' && data.error) {
        // Handle error case
        console.error(`Log stream error for ${data.resourceId}: ${data.error}`);
        
        // If this was the selected resource, show error in log viewer
        if (selectedLogResource && selectedLogResource.physicalResourceId === data.resourceId) {
          // Keep the log viewer open but show error message
          // The actual error message will be shown in the LogViewerModal component
        }
      }
    };
    
    // Handle log stream errors
    const handleLogStreamError = (data: { resourceId: string, error: string }) => {
      console.error(`ResourceConsole: Log stream error for ${data.resourceId}: ${data.error}`);
      
      // If this was the selected resource, show error in log viewer
      if (selectedLogResource && selectedLogResource.physicalResourceId === data.resourceId) {
        // Keep the log viewer open but show error message
        // The actual error message will be shown in the LogViewerModal component
      }
    };
    
    socket.on('activeLogStreams', handleActiveLogStreams);
    socket.on('logStreamStatus', handleLogStreamStatus);
    socket.on('logStreamError', handleLogStreamError);
    
    return () => {
      // socket.off('deploymentInProgress', handleDeploymentInProgress);
      socket.off('activeLogStreams', handleActiveLogStreams);
      socket.off('logStreamStatus', handleLogStreamStatus);
      socket.off('logStreamError', handleLogStreamError);
    };
  }, [socket, selectedLogResource]);
  
  // // Update deployment message when sandbox status changes
  // useEffect(() => {
  //   if (sandboxStatus === 'deploying') {
  //     setDeploymentMessage('Sandbox is being deployed...');
  //   } else if (sandboxStatus === 'running') {
  //     // Always clear deployment message when status changes to running
  //     setDeploymentMessage('');
  //   }
  // }, [sandboxStatus]);
  
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
  }, [resources, sandboxStatus]);

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
  
  // Main render with split-screen layout
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
        
        {!regionAvailable && (
          <StatusIndicator type="warning">
            AWS region could not be detected. Console links are unavailable.
          </StatusIndicator>
        )}

        {/* Split view layout - show resources on left and logs on right when a log is being viewed */}
        <Grid gridDefinition={showLogViewer ? [{ colspan: 6 }, { colspan: 6 }] : [{ colspan: 12 }]}>
          {/* Left side - Resources */}
          <div>
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
          </div>
          
          {/* Right side - Log Viewer */}
          {showLogViewer && selectedLogResource && (
            <ResourceLogPanel
              resourceId={selectedLogResource.physicalResourceId}
              resourceName={selectedLogResource.friendlyName || selectedLogResource.logicalResourceId}
              resourceType={selectedLogResource.resourceType}
              onClose={() => {
                setShowLogViewer(false);
                // Request updated active log streams when closing the panel
                if (socket) {
                  socket.emit('getActiveLogStreams');
                }
              }}
              socket={socket}
            />
          )}
        </Grid>
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
        
const ResourceConsoleWithLogs: React.FC<ResourceConsoleProps> = (props) => {
  return <ResourceConsole {...props} />;
};

export default ResourceConsoleWithLogs;
