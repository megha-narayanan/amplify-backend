import React, { useState, useMemo, useEffect } from 'react';
import { Socket } from 'socket.io-client';
import { useResourceManager, ResourceWithFriendlyName } from '../hooks/useResourceManager';
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
  Badge,
  Modal
} from '@cloudscape-design/components';

/**
 * Get AWS console URL for a resource
 * @param resource The resource
 * @param region The AWS region
 * @returns The AWS console URL
 */
const getAwsConsoleUrl = (resource: ResourceWithFriendlyName, region: string | null): string | null => {
  if (!region) return null;
  
  const baseUrl = `https://${region}.console.aws.amazon.com`;
  
  switch (resource.resourceType) {
    case 'AWS::Lambda::Function':
      return `${baseUrl}/lambda/home?region=${region}#/functions/${resource.physicalResourceId}`;
    case 'AWS::ApiGateway::RestApi':
      return `${baseUrl}/apigateway/home?region=${region}#/apis/${resource.physicalResourceId}/resources`;
    case 'AWS::DynamoDB::Table':
      return `${baseUrl}/dynamodb/home?region=${region}#tables:selected=${resource.physicalResourceId}`;
    case 'AWS::S3::Bucket':
      return `${baseUrl}/s3/buckets/${resource.physicalResourceId}?region=${region}`;
    case 'AWS::Cognito::UserPool':
      return `${baseUrl}/cognito/home?region=${region}#/pool/${resource.physicalResourceId}/details`;
    case 'AWS::AppSync::GraphQLApi':
      return `${baseUrl}/appsync/home?region=${region}#/${resource.physicalResourceId}/v1/home`;
    default:
      return null;
  }
};

interface ResourceConsoleProps {
  socket: Socket | null;
  sandboxStatus?: 'running' | 'stopped' | 'nonexistent' | 'unknown' | 'deploying';
}

// Define column definitions type
type ColumnDefinition = {
  id: string;
  header: string;
  cell: (item: ResourceWithFriendlyName) => React.ReactNode;
  width: number;
  minWidth: number;
};

const ResourceConsole: React.FC<ResourceConsoleProps> = ({ socket, sandboxStatus = 'unknown' }) => {
  const [lastRefreshTime, setLastRefreshTime] = useState<number>(0);
  const deploymentInProgress = sandboxStatus === 'deploying';
  const [initializing, setInitializing] = useState<boolean>(true);
  const [activeLogStreams, setActiveLogStreams] = useState<string[]>([]);
  const [selectedLogResource, setSelectedLogResource] = useState<ResourceWithFriendlyName | null>(null);
  const [showLogViewer, setShowLogViewer] = useState<boolean>(false);
  const [editingResource, setEditingResource] = useState<ResourceWithFriendlyName | null>(null);
  const [editingFriendlyName, setEditingFriendlyName] = useState<string>('');
  const REFRESH_COOLDOWN_MS = 5000; // 5 seconds minimum between refreshes
  
  // Helper function to check if a resource supports logs
  const supportsLogs = (resource: ResourceWithFriendlyName): boolean => {
    return (
      resource.resourceType === 'AWS::Lambda::Function' ||
      resource.resourceType === 'AWS::ApiGateway::RestApi' ||
      resource.resourceType === 'AWS::AppSync::GraphQLApi'
    );
  };

  // Use the resource manager hook
  const { 
    resources, 
    isLoading, 
    error,
    region,
    updateCustomFriendlyName,
    removeCustomFriendlyName,
    getResourceDisplayName,
    refreshResources: originalRefreshResources 
  } = useResourceManager(socket, undefined, sandboxStatus);
  
  // Define column definitions for all tables
  const columnDefinitions = React.useMemo<ColumnDefinition[]>(() => [
    {
      id: 'name',
      header: 'Resource Name',
      cell: (item: ResourceWithFriendlyName) => {
        const isLogging = activeLogStreams.includes(item.physicalResourceId);
        return (
          <SpaceBetween direction="horizontal" size="xs">
            <div style={{ display: 'flex', alignItems: 'center' }}>
              {getResourceDisplayName(item)}
              <Button 
                variant="icon" 
                iconName="edit" 
                onClick={(e) => {
                  e.stopPropagation();
                  handleEditFriendlyName(item);
                }}
                disabled={deploymentInProgress}
                ariaLabel="Edit friendly name"
              />
            </div>
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
      cell: (item: ResourceWithFriendlyName) => item.logicalResourceId,
      width: 600,
      minWidth: 200
    },
    {
      id: 'status',
      header: 'Status',
      cell: (item: ResourceWithFriendlyName) => (
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
      cell: (item: ResourceWithFriendlyName) => item.physicalResourceId,
      width: 600,
      minWidth: 300
    },
    {
      id: 'actions',
      header: 'Actions',
      cell: (item: ResourceWithFriendlyName) => {
        const url = getAwsConsoleUrl(item, region);
        const isLogging = activeLogStreams.includes(item.physicalResourceId);
        
        return (
          <SpaceBetween direction="horizontal" size="xs">
            {url && (
              deploymentInProgress ? (
                <span style={{ color: '#888' }}>
                  View in AWS Console (disabled during deployment)
                </span>
              ) : (
                <Link href={url} external>
                  View in AWS Console
                </Link>
              )
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
                  disabled={deploymentInProgress || !!(showLogViewer && selectedLogResource && selectedLogResource.physicalResourceId === item.physicalResourceId)}
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
                  disabled={deploymentInProgress}
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
  ], [activeLogStreams, region, selectedLogResource, deploymentInProgress, showLogViewer]);

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
      socket.off('activeLogStreams', handleActiveLogStreams);
      socket.off('logStreamStatus', handleLogStreamStatus);
      socket.off('logStreamError', handleLogStreamError);
    };
  }, [socket, selectedLogResource]);
  
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
    if (!resources) return [];
    
    const types = new Set<string>();
    resources.forEach((resource: ResourceWithFriendlyName) => {
      if (resource.resourceType !== 'AWS::CDK::Metadata') {
        types.add(resource.resourceType);
      }
    });
    
    return Array.from(types).map(type => ({ label: type, value: type }));
  }, [resources, sandboxStatus]);

  const statusOptions = useMemo(() => {
    if (!resources) return [];
    
    const statuses = new Set<string>();
    resources.forEach((resource: ResourceWithFriendlyName) => {
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
  
  // Handle editing a resource's friendly name
  const handleEditFriendlyName = (resource: ResourceWithFriendlyName) => {
    setEditingResource(resource);
    setEditingFriendlyName(getResourceDisplayName(resource));
  };
  

  const refreshFriendlyNames = () => {
    if (socket) {
      socket.emit('getCustomFriendlyNames');
    }
  };
  

  const handleSaveFriendlyName = () => {
    if (editingResource) {
      updateCustomFriendlyName(editingResource.physicalResourceId, editingFriendlyName);
      
      setEditingResource(null);
    
      refreshFriendlyNames();
    }
  };
  
  const handleRemoveFriendlyName = () => {
    if (editingResource) {

      removeCustomFriendlyName(editingResource.physicalResourceId);
    
      setEditingResource(null);

      refreshFriendlyNames();
    }
  };

  // Filter resources based on search query and selected filters
  const filteredResources = useMemo(() => {
    if (!resources) return [];
    
    return resources.filter((resource: ResourceWithFriendlyName) => {
      // Filter out CDK metadata
      if (resource.resourceType === 'AWS::CDK::Metadata') return false;
      
      // Apply search filter
      const searchLower = searchQuery.toLowerCase();
      const matchesSearch = searchQuery === '' || 
        resource.logicalResourceId.toLowerCase().includes(searchLower) ||
        resource.physicalResourceId.toLowerCase().includes(searchLower) ||
        getResourceDisplayName(resource).toLowerCase().includes(searchLower) ||
        resource.resourceType.toLowerCase().includes(searchLower);
      
      const matchesServiceType = selectedServiceTypes.length === 0 || 
        selectedServiceTypes.some(option => option.value === resource.resourceType);
      
      const matchesStatus = selectedStatuses.length === 0 || 
        selectedStatuses.some(option => option.value === resource.resourceStatus);
      
      return matchesSearch && matchesServiceType && matchesStatus;
    });
  }, [resources, searchQuery, selectedServiceTypes, selectedStatuses, getResourceDisplayName]);

  // Group filtered resources by service and then by resource type
  const groupedResources = useMemo(() => {
    const serviceGroups: Record<string, Record<string, ResourceWithFriendlyName[]>> = {};
    
    filteredResources.forEach((resource: ResourceWithFriendlyName) => {
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
  if ((initializing || (isLoading && (!resources || resources.length === 0))) && !deploymentInProgress) {
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
          {!isLoading && resources && Object.keys(groupedResources).length > 0 && (
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
              {resources && resources.length > 0 && (
                <p>Showing resources from the previous deployment.</p>
              )}
            </TextContent>
            <Button onClick={refreshResources}>Refresh Resources</Button>
          </Box>
          
          {/* Show resources if available, even during deployment */}
          {resources && resources.length > 0 && (
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
      {/* Friendly Name Edit Modal */}
      <Modal
        visible={editingResource !== null}
        onDismiss={() => setEditingResource(null)}
        header="Edit Resource Name"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={() => setEditingResource(null)}>Cancel</Button>
              <Button variant="link" onClick={handleRemoveFriendlyName}>Reset to Default</Button>
              <Button variant="primary" onClick={handleSaveFriendlyName}>Save</Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween direction="vertical" size="m">
          <FormField label="Resource ID">
            <div>{editingResource?.physicalResourceId}</div>
          </FormField>
          <FormField label="Resource Type">
            <div>{editingResource?.resourceType}</div>
          </FormField>
          <FormField label="Custom Name">
            <Input
              value={editingFriendlyName}
              onChange={({ detail }) => setEditingFriendlyName(detail.value)}
            />
          </FormField>
        </SpaceBetween>
      </Modal>
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
              resourceName={getResourceDisplayName(selectedLogResource)}
              resourceType={selectedLogResource.resourceType}
              onClose={() => {
                setShowLogViewer(false);
                // Request updated active log streams when closing the panel
                if (socket) {
                  socket.emit('getActiveLogStreams');
                }
              }}
              socket={socket}
              deploymentInProgress={deploymentInProgress}
            />
          )}
        </Grid>
      </SpaceBetween>
    </Container>
  );
};


interface ResourceDisplayProps {
  groupedResources: Record<string, Record<string, ResourceWithFriendlyName[]>>;
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
