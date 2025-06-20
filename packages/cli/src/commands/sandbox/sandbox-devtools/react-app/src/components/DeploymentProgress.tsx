import React, { useState, useEffect, useRef } from 'react';
import { Socket } from 'socket.io-client';
import {
  Container,
  Header,
  SpaceBetween,
  Box,
  Button,
  Spinner
} from '@cloudscape-design/components';

interface DeploymentProgressProps {
  socket: Socket | null;
  visible: boolean;
  status?: 'running' | 'stopped' | 'nonexistent' | 'unknown' | 'deploying';
  deploymentCompleted?: boolean;
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
  status
}) => {
  // Determine if deployment is in progress based on status prop
  const isDeploying = status === 'deploying';
  const [events, setEvents] = useState<DeploymentEvent[]>([]);
  const [resourceStatuses, setResourceStatuses] = useState<Record<string, ResourceStatus>>({});
  const containerRef = useRef<HTMLDivElement>(null);
  
  // Parse deployment progress message to extract structured information
  const parseDeploymentMessage = (message: string): ResourceStatus | null => {
    // Try to parse CloudFormation event format: "4:14:26 PM | DELETE_IN_PROGRESS | CloudFormation:Stack | root stack"
    const cfnMatch = message.match(/(\d+:\d+:\d+\s+[AP]M)\s+\|\s+([A-Z_]+)\s+\|\s+([^|]+)\s+\|\s+(.+)/);
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
        key
      };
    }
    
    return null;
  };
  
  // Get spinner status based on resource status
  const getSpinnerStatus = (status: string): boolean => {
    return status.includes('IN_PROGRESS');
  };
  
  // Listen for deployment events
  useEffect(() => {
    if (!socket) return;
    
    const handleDeploymentInProgress = (data: { message: string; timestamp: string }) => {
      // Try to parse the message as a CloudFormation event
      const resourceStatus = parseDeploymentMessage(data.message);
      
      if (resourceStatus) {
        // Update the resource status
        setResourceStatuses(prev => ({
          ...prev,
          [resourceStatus.key]: resourceStatus
        }));
        
        // Add to events list
        setEvents(prev => [
          ...prev, 
          {
            message: data.message,
            timestamp: data.timestamp || new Date().toISOString(),
            resourceStatus
          }
        ]);
      } else {
        // Add as a generic event
        setEvents(prev => [
          ...prev, 
          {
            message: data.message,
            timestamp: data.timestamp || new Date().toISOString(),
            isGeneric: true
          }
        ]);
      }
    };
    
    const handleDeploymentCompleted = (data: { message: string; timestamp: string; error?: boolean }) => {
      
      // Add completion event
      setEvents(prev => [
        ...prev, 
        {
          message: data.message || 'Deployment completed successfully',
          timestamp: data.timestamp || new Date().toISOString(),
          isGeneric: true
        }
      ]);
    };
    
    socket.on('deploymentInProgress', handleDeploymentInProgress);
    socket.on('deploymentCompleted', handleDeploymentCompleted);
    
    return () => {
      socket.off('deploymentInProgress', handleDeploymentInProgress);
      socket.off('deploymentCompleted', handleDeploymentCompleted);
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
  
  // If not visible, don't render
  if (!visible) {
    return null;
  }
  
  // Group resources by type for better organization
  const resourcesByType: Record<string, ResourceStatus[]> = {};
  Object.values(resourceStatuses).forEach(resource => {
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
            <Button onClick={clearEvents} disabled={isDeploying}>
              Clear Events
            </Button>
          }
        >
          Deployment Progress
          {isDeploying && (
            <span style={{ marginLeft: '8px', display: 'inline-flex', alignItems: 'center' }}>
              <Spinner size="normal" /> 
              <span style={{ marginLeft: '4px' }}>In progress</span>
            </span>
          )}
        </Header>
      }
    >
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
          border: '1px solid #333'
        }}
      >
        {events.length === 0 ? (
          <Box textAlign="center" padding="m" color="inherit">
            <SpaceBetween size="m">
              {isDeploying ? (
                <>
                  <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '10px' }}>
                    <Spinner />
                    <span>Waiting for deployment events...</span>
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
            {sortedResourceTypes.map(resourceType => (
              <div key={resourceType} style={{ marginBottom: '16px' }}>
                <div style={{ 
                  color: '#4db6ac', 
                  borderBottom: '1px solid #333',
                  paddingBottom: '4px',
                  marginBottom: '8px',
                  fontWeight: 'bold'
                }}>
                  {resourceType}
                </div>
                
                {resourcesByType[resourceType].map(resource => (
                  <div key={resource.key} style={{ 
                    display: 'flex', 
                    alignItems: 'center', 
                    padding: '4px 0',
                    marginLeft: '16px'
                  }}>
                    <div style={{ 
                      width: '20px', 
                      marginRight: '8px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center'
                    }}>
                      {getSpinnerStatus(resource.status) ? (
                        <div className="spinner" style={{ 
                          width: '12px', 
                          height: '12px', 
                          borderRadius: '50%',
                          border: '2px solid #4db6ac',
                          borderTopColor: 'transparent',
                          animation: 'spin 1s linear infinite'
                        }} />
                      ) : (
                        <span style={{ 
                          color: resource.status.includes('COMPLETE') ? '#4caf50' : 
                                 resource.status.includes('FAILED') ? '#f44336' : 
                                 resource.status.includes('DELETE') ? '#ff9800' : '#2196f3'
                        }}>
                          {resource.status.includes('COMPLETE') ? '✓' : 
                           resource.status.includes('FAILED') ? '✗' : 
                           resource.status.includes('DELETE') ? '!' : '•'}
                        </span>
                      )}
                    </div>
                    <div>
                      <div style={{ color: '#f0f0f0' }}>{resource.resourceName}</div>
                      <div style={{ fontSize: '12px', color: '#9e9e9e' }}>
                        {resource.status} • {resource.timestamp}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ))}
            
            {/* Show generic events at the bottom */}
            {events.filter(event => event.isGeneric).length > 0 && (
              <div style={{ marginTop: '16px', borderTop: '1px solid #444', paddingTop: '16px' }}>
                {events.filter(event => event.isGeneric).map((event, index) => (
                  <div key={index} style={{ marginBottom: '8px', display: 'flex', alignItems: 'center' }}>
                    {isDeploying && index === events.filter(e => e.isGeneric).length - 1 ? (
                      <div className="spinner" style={{ 
                        width: '12px', 
                        height: '12px', 
                        borderRadius: '50%',
                        border: '2px solid #4db6ac',
                        borderTopColor: 'transparent',
                        animation: 'spin 1s linear infinite',
                        marginRight: '8px'
                      }} />
                    ) : (
                      <span style={{ marginRight: '8px', color: '#9e9e9e' }}>•</span>
                    )}
                    <span>{event.message}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      
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
