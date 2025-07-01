import React, { useState, useEffect, useRef } from 'react';
import { Socket } from 'socket.io-client';
import {
  Container,
  Header,
  SpaceBetween,
  Box,
  Button,
  Spinner,
  ExpandableSection,
} from '@cloudscape-design/components';
import { SandboxStatus } from '../App';

interface DeploymentProgressProps {
  socket: Socket | null;
  visible: boolean;
  status: SandboxStatus;
}

interface ResourceStatus {
  resourceType: string;
  resourceName: string;
  status: string;
  timestamp: string;
  key: string;
}

interface DeploymentEvent {
  message: string;
  timestamp: string;
  resourceStatus?: ResourceStatus;
  isGeneric?: boolean;
}

const DeploymentProgress: React.FC<DeploymentProgressProps> = ({
  socket,
  visible,
  status,
}) => {
  const [events, setEvents] = useState<DeploymentEvent[]>([]);
  const [resourceStatuses, setResourceStatuses] = useState<
    Record<string, ResourceStatus>
  >({});
  const containerRef = useRef<HTMLDivElement>(null);

  const [expanded, setExpanded] = useState<boolean>(
    status === 'deploying' || status === 'deleting',
  );

  // Update expanded state when deployment or deletion status changes
  useEffect(() => {
    if (status === 'deploying' || status === 'deleting') {
      setExpanded(true);
    }
  }, [status]);

  // Parse deployment progress message to extract structured information
  const parseDeploymentMessage = (message: string): ResourceStatus | null => {
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

  const getSpinnerStatus = (status: string): boolean => {
    return status.includes('IN_PROGRESS');
  };

  useEffect(() => {
    if (!socket) return;

    if (status === 'deploying' || status === 'deleting') {
      setEvents([]);
      setResourceStatuses({});
    }

    // Request saved deployment progress when component mounts
    console.log('DeploymentProgress: Requesting saved deployment progress');
    socket.emit('getSavedDeploymentProgress');

    const handleDeploymentInProgress = (data: {
      message: string;
      timestamp: string;
    }) => {
      const resourceStatus = parseDeploymentMessage(data.message);

      if (resourceStatus) {
        setResourceStatuses((prev) => ({
          ...prev,
          [resourceStatus.key]: resourceStatus,
        }));

        setEvents((prev) => [
          ...prev,
          {
            message: data.message,
            timestamp: data.timestamp || new Date().toISOString(),
            resourceStatus,
          },
        ]);
      } else {
        // Add as a generic event
        setEvents((prev) => [
          ...prev,
          {
            message: data.message,
            timestamp: data.timestamp || new Date().toISOString(),
            isGeneric: true,
          },
        ]);
      }
    };

    const handleSavedDeploymentProgress = (
      savedEvents: Array<{ message: string; timestamp: string }>,
    ) => {
      console.log(
        'Received saved deployment progress events:',
        savedEvents.length,
      );

      // Don't process saved events during deployment OR deletion
      if (status !== 'deploying' && status !== 'deleting') {
        // Process each saved event
        const newResourceStatuses: Record<string, ResourceStatus> = {};
        const processedEvents: DeploymentEvent[] = [];

        savedEvents.forEach((data) => {
          const resourceStatus = parseDeploymentMessage(data.message);

          if (resourceStatus) {
            newResourceStatuses[resourceStatus.key] = resourceStatus;

            processedEvents.push({
              message: data.message,
              timestamp: data.timestamp || new Date().toISOString(),
              resourceStatus,
            });
          } else {
            processedEvents.push({
              message: data.message,
              timestamp: data.timestamp || new Date().toISOString(),
              isGeneric: true,
            });
          }
        });

        // Update state with all processed events
        setResourceStatuses(newResourceStatuses);
        setEvents(processedEvents);
      } else {
        console.log(
          'Ignoring saved deployment events because deployment or deletion is in progress',
        );
      }
    };

    socket.on('deploymentInProgress', handleDeploymentInProgress);
    socket.on('savedDeploymentProgress', handleSavedDeploymentProgress);

    return () => {
      socket.off('deploymentInProgress', handleDeploymentInProgress);
      socket.off('savedDeploymentProgress', handleSavedDeploymentProgress);
    };
  }, [socket]);

  // Auto-scroll to bottom when events change
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [events]);

  // Clear events
  const clearEvents = () => {
    setEvents([]);
    setResourceStatuses({});
  };

  const showContent = visible || events.length > 0;

  // Group resources by type for better organization
  const resourcesByType: Record<string, ResourceStatus[]> = {};
  Object.values(resourceStatuses).forEach((resource) => {
    if (!resourcesByType[resource.resourceType]) {
      resourcesByType[resource.resourceType] = [];
    }
    resourcesByType[resource.resourceType].push(resource);
  });

  // Sort resource types
  const sortedResourceTypes = Object.keys(resourcesByType).sort();

  return (
    <Container
      header={
        <Header
          variant="h2"
          actions={
            <Button onClick={clearEvents} disabled={status === 'deploying'}>
              Clear Events
            </Button>
          }
        >
          Deployment Progress
          {(status === 'deploying' || status === 'deleting') && (
            <span
              style={{
                marginLeft: '8px',
                display: 'inline-flex',
                alignItems: 'center',
              }}
            >
              <Spinner size="normal" />
              <span style={{ marginLeft: '4px' }}>In progress</span>
            </span>
          )}
        </Header>
      }
    >
      <ExpandableSection
        headerText={
          status === 'deploying'
            ? 'Deployment in progress'
            : status === 'deleting'
              ? 'Deletion in progress'
              : 'Deployment history'
        }
        expanded={expanded}
        onChange={({ detail }) => setExpanded(detail.expanded)}
        headerCounter={
          events.length > 0 ? `${events.length} events` : undefined
        }
        headerDescription={
          status === 'deploying'
            ? 'Deployment is currently running'
            : status === 'deleting'
              ? 'Deletion is currently running'
              : events.length > 0
                ? 'Previous deployment events'
                : 'No deployment events'
        }
      >
        {showContent && (
          <div
            ref={containerRef}
            style={{
              overflow: 'auto',
              maxHeight: '500px',
              backgroundColor: '#1a1a1a',
              color: '#f0f0f0',
              padding: '16px',
              fontFamily: 'monospace',
              fontSize: '14px',
              borderRadius: '4px',
              border: '1px solid #333',
            }}
          >
            {events.length === 0 ? (
              <Box textAlign="center" padding="m" color="inherit">
                <SpaceBetween size="m">
                  {status === 'deploying' || status === 'deleting' ? (
                    <>
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'center',
                          alignItems: 'center',
                          gap: '10px',
                        }}
                      >
                        <Spinner />
                        <span>
                          <span>Waiting for deployment events...</span>
                        </span>
                      </div>
                    </>
                  ) : (
                    <div>No deployment events</div>
                  )}
                </SpaceBetween>
              </Box>
            ) : (
              <div>
                {/* Group resources by type */}
                {sortedResourceTypes.map((resourceType) => (
                  <div key={resourceType} style={{ marginBottom: '16px' }}>
                    <div
                      style={{
                        color: '#4db6ac',
                        borderBottom: '1px solid #333',
                        paddingBottom: '4px',
                        marginBottom: '8px',
                        fontWeight: 'bold',
                      }}
                    >
                      {resourceType}
                    </div>

                    {resourcesByType[resourceType].map((resource) => (
                      <div
                        key={resource.key}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          padding: '4px 0',
                          marginLeft: '16px',
                        }}
                      >
                        <div
                          style={{
                            width: '20px',
                            marginRight: '8px',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          {getSpinnerStatus(resource.status) ? (
                            <div
                              className="spinner"
                              style={{
                                width: '12px',
                                height: '12px',
                                borderRadius: '50%',
                                border: '2px solid #4db6ac',
                                borderTopColor: 'transparent',
                                animation: 'spin 1s linear infinite',
                              }}
                            />
                          ) : (
                            <span
                              style={{
                                color: resource.status.includes('COMPLETE')
                                  ? '#4caf50'
                                  : resource.status.includes('FAILED')
                                    ? '#f44336'
                                    : resource.status.includes('DELETE')
                                      ? '#ff9800'
                                      : '#2196f3',
                              }}
                            >
                              {resource.status.includes('COMPLETE')
                                ? '✓'
                                : resource.status.includes('FAILED')
                                  ? '✗'
                                  : resource.status.includes('DELETE')
                                    ? '!'
                                    : '•'}
                            </span>
                          )}
                        </div>
                        <div>
                          <div style={{ color: '#f0f0f0' }}>
                            {resource.resourceName}
                          </div>
                          <div style={{ fontSize: '12px', color: '#9e9e9e' }}>
                            {resource.status} • {resource.timestamp}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ))}

                {/* Show generic events at the bottom */}
                {events.filter((event) => event.isGeneric).length > 0 && (
                  <div
                    style={{
                      marginTop: '16px',
                      borderTop: '1px solid #444',
                      paddingTop: '16px',
                    }}
                  >
                    {events
                      .filter((event) => event.isGeneric)
                      .map((event, index) => (
                        <div
                          key={index}
                          style={{
                            marginBottom: '8px',
                            display: 'flex',
                            alignItems: 'center',
                          }}
                        >
                          {(status === 'deploying' || status === 'deleting') &&
                          index ===
                            events.filter((e) => e.isGeneric).length - 1 ? (
                            <div
                              className="spinner"
                              style={{
                                width: '12px',
                                height: '12px',
                                borderRadius: '50%',
                                border: '2px solid #4db6ac',
                                borderTopColor: 'transparent',
                                animation: 'spin 1s linear infinite',
                                marginRight: '8px',
                              }}
                            />
                          ) : (
                            <span
                              style={{ marginRight: '8px', color: '#9e9e9e' }}
                            >
                              •
                            </span>
                          )}
                          <span>{event.message}</span>
                        </div>
                      ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </ExpandableSection>

      {/* Add CSS for spinner animation */}
      <style>
        {`
          @keyframes spin {
            to { transform: rotate(360deg); }
          }
          .spinner {
            animation: spin 1s linear infinite;
          }
        `}
      </style>
    </Container>
  );
};

export default DeploymentProgress;
