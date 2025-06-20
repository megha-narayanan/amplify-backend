import React, { useState } from 'react';
import {
  ExpandableSection,
  Badge,
  SpaceBetween,
  Button,
  StatusIndicator,
  Container
} from '@cloudscape-design/components';
import ResourceLogViewer from './ResourceLogViewer';

interface ResourceCardProps {
  resource: {
    logicalResourceId: string;
    physicalResourceId: string;
    resourceType: string;
    resourceStatus: string;
    friendlyName?: string;
  };
  isLoggingActive: boolean;
  onToggleLogging: () => void;
}

const ResourceCard: React.FC<ResourceCardProps> = ({ 
  resource,
  isLoggingActive,
  onToggleLogging
}) => {
  const [showLogs, setShowLogs] = useState(false);

  const getStatusType = (status: string): "success" | "info" | "warning" | "error" | "pending" => {
    if (status.includes('COMPLETE')) return 'success';
    if (status.includes('PROGRESS')) return 'pending';
    if (status.includes('FAILED')) return 'error';
    return 'info';
  };

  const getResourceTypeShort = (type: string) => {
    return type.replace('AWS::', '').replace('::', ':');
  };

  const supportsLogs = () => {
    return (
      resource.resourceType === 'AWS::Lambda::Function' ||
      resource.resourceType === 'AWS::ApiGateway::RestApi' ||
      resource.resourceType === 'AWS::AppSync::GraphQLApi'
    );
  };

  return (
    <Container
      header={
        <SpaceBetween direction="horizontal" size="xs">
          <div>{resource.friendlyName || resource.logicalResourceId}</div>
          {isLoggingActive && (
            <Badge color="green">Logging Active</Badge>
          )}
        </SpaceBetween>
      }
    >
      <SpaceBetween direction="vertical" size="s">
        <SpaceBetween direction="horizontal" size="xs">
          <StatusIndicator type={getStatusType(resource.resourceStatus)}>
            {resource.resourceStatus}
          </StatusIndicator>
          <Badge>{getResourceTypeShort(resource.resourceType)}</Badge>
        </SpaceBetween>
        
        <ExpandableSection headerText="Resource Details">
          <SpaceBetween direction="vertical" size="xs">
            <div><strong>Logical ID:</strong> {resource.logicalResourceId}</div>
            <div><strong>Physical ID:</strong> {resource.physicalResourceId}</div>
            <div><strong>Type:</strong> {resource.resourceType}</div>
          </SpaceBetween>
        </ExpandableSection>
        
        {supportsLogs() && (
          <Button 
            onClick={showLogs ? () => setShowLogs(false) : onToggleLogging}
          >
            {showLogs ? "Hide Logs" : (isLoggingActive ? "Stop Logs" : "View Logs")}
          </Button>
        )}
        
        {showLogs && (
          <ResourceLogViewer 
            resourceId={resource.physicalResourceId}
            resourceName={resource.friendlyName || resource.logicalResourceId}
            onClose={() => setShowLogs(false)}
          />
        )}
      </SpaceBetween>
    </Container>
  );
};

export default ResourceCard;
