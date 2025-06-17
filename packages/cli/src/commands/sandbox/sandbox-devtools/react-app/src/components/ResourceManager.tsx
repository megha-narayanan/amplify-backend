import React, { useEffect, useState } from 'react';
import { Socket } from 'socket.io-client';

export interface Resource {
  logicalResourceId: string;
  physicalResourceId: string;
  resourceType: string;
  resourceStatus: string;
  friendlyName?: string;
}

export interface FunctionConfiguration {
  functionName: string;
  status: string;
  lastUpdated?: Date;
  friendlyName?: string;
}

export interface BackendMetadata {
  name: string;
  status: string;
  lastUpdated?: Date;
  deploymentType?: string;
  resources: Resource[];
  functionConfigurations?: FunctionConfiguration[];
  region?: string; // Added region property
}

interface ResourceManagerProps {
  socket: Socket | null;
  onResourcesLoaded: (resources: BackendMetadata | null) => void;
}

// Custom hook for managing resources
export const useResourceManager = (
  socket: Socket | null, 
  onResourcesLoaded?: (resources: BackendMetadata | null) => void,
  sandboxStatus?: 'running' | 'stopped' | 'nonexistent' | 'unknown' | 'deploying'
) => {
  const [resources, setResources] = useState<BackendMetadata | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  // Use a ref to store the last known resources
  const lastKnownResources = React.useRef<BackendMetadata | null>(null);
  // Track if we've requested resources at least once
  const hasRequestedResources = React.useRef<boolean>(false);

  useEffect(() => {
    if (!socket) return;

    // Handle socket connect/reconnect events
    const handleConnect = () => {
      console.log('ResourceManager: Socket connected, checking if resources need to be requested');
      
      // Only request resources if the sandbox is running and we haven't requested them yet
      // or if we're reconnecting and the sandbox is running
      if (sandboxStatus === 'running' || (sandboxStatus !== 'stopped' && !hasRequestedResources.current)) {
        console.log('ResourceManager: Requesting resources on connect');
        requestResources();
      }
    };

    // Listen for connect event
    socket.on('connect', handleConnect);
    
    // If socket is already connected, check if we need to request resources
    if (socket.connected && !hasRequestedResources.current) {
      console.log('ResourceManager: Socket already connected, checking if resources need to be requested');
      handleConnect();
    }

    // Listen for deployed backend resources
    socket.on('deployedBackendResources', (data: BackendMetadata) => {
      console.log('ResourceManager: Received backend resources', data);
      setResources(data);
      // Store the resources in our ref for caching
      lastKnownResources.current = data;
      setLoading(false);
      setError(null); // Clear any previous errors
      if (onResourcesLoaded) {
        onResourcesLoaded(data);
      }
    });
    
    // Listen for errors
    socket.on('error', (data: { message: string }) => {
      // Check if this is a deployment in progress error
      if (data.message.includes('deployment is in progress') || 
          data.message.includes('deployment in progress')) {
        // Don't set error for deployment in progress, it will be handled by the deploymentInProgress event
        console.log('ResourceManager: Deployment in progress detected from error message:', data.message);
        socket.emit('deploymentInProgress', { message: data.message });
      } else {
        // For other errors, set the error state
        console.error('ResourceManager: Error received:', data.message);
        setError(data.message);
      }
      setLoading(false);
    });

    // Listen for deployment completion to refresh resources
    socket.on('deploymentCompleted', () => {
      console.log('ResourceManager: Deployment completed, refreshing resources');
      if (sandboxStatus !== 'stopped') {
        refreshResources();
      }
    });

    // Listen for resource configuration changes to refresh resources
    socket.on('resourceConfigChanged', () => {
      console.log('ResourceManager: Resource config changed, refreshing resources');
      if (sandboxStatus !== 'stopped') {
        refreshResources();
      }
    });

    // Listen for sandbox status changes
    socket.on('sandboxStatus', (data: { status: 'running' | 'stopped' | 'nonexistent' | 'unknown' | 'deploying' }) => {
      console.log(`ResourceManager: Sandbox status changed to ${data.status}`);
      // If the sandbox was stopped and is now running, refresh resources
      if (data.status === 'running') {
        console.log('ResourceManager: Sandbox is now running, refreshing resources');
        refreshResources();
      }
    });

    // Clean up listeners when component unmounts
    return () => {
      socket.off('connect', handleConnect);
      socket.off('deployedBackendResources');
      socket.off('deploymentCompleted');
      socket.off('resourceConfigChanged');
      socket.off('sandboxStatus');
      socket.off('error');
    };
  }, [socket, onResourcesLoaded, sandboxStatus]);

  // Effect to handle sandbox status changes
  useEffect(() => {
    if (!socket) return;
    
    // If sandbox status changes to running and we have a socket, request resources
    if (sandboxStatus === 'running') {
      console.log('ResourceManager: Sandbox status is running, checking if resources need to be requested');
      if (!resources && !lastKnownResources.current) {
        console.log('ResourceManager: No resources loaded yet, requesting resources');
        requestResources();
      }
    } else if (sandboxStatus === 'stopped' && lastKnownResources.current) {
      // If sandbox is stopped and we have cached resources, use them
      console.log('ResourceManager: Sandbox is stopped, using cached resources');
      setResources(lastKnownResources.current);
    }
  }, [sandboxStatus, socket]);

  // Track last refresh time to prevent throttling
  const [lastRefreshTime, setLastRefreshTime] = useState<number>(0);
  const REFRESH_COOLDOWN_MS = 2000; // 2 seconds minimum between refreshes

  // Function to request resources without rate limiting
  const requestResources = () => {
    if (!socket || !socket.connected) {
      console.error('ResourceManager: Cannot request resources, socket not connected');
      setError('Socket connection not available');
      return;
    }
    
    console.log('ResourceManager: Requesting deployed backend resources');
    socket.emit('getDeployedBackendResources');
    hasRequestedResources.current = true;
    
    // Only set loading to true if we don't have resources yet
    if (!resources && !lastKnownResources.current) {
      setLoading(true);
    }
  };

  // Rate-limited function to refresh resources
  const refreshResources = () => {
    if (!socket || !socket.connected) {
      console.error('ResourceManager: Cannot refresh resources, socket not connected');
      setError('Socket connection not available');
      return;
    }
    
    // Don't refresh if sandbox is stopped
    if (sandboxStatus === 'stopped') {
      console.log('ResourceManager: Sandbox is stopped, not refreshing resources');
      return;
    }
    
    const now = Date.now();
    if (now - lastRefreshTime < REFRESH_COOLDOWN_MS) {
      console.log('ResourceManager: Refresh cooldown in effect, skipping refresh');
      return;
    }
    
    console.log('ResourceManager: Refreshing resources');
    socket.emit('getDeployedBackendResources');
    hasRequestedResources.current = true;
    setLastRefreshTime(now);
    
    // Only set loading to true if we don't have resources yet
    if (!resources && !lastKnownResources.current) {
      setLoading(true);
    }
  };

  return { resources, loading, error, refreshResources };
};

// The actual ResourceManager component that uses the hook
const ResourceManager: React.FC<ResourceManagerProps> = ({ socket, onResourcesLoaded }) => {
  useResourceManager(socket, onResourcesLoaded);
  
  // NOTE: actual UI will be handled by the ResourceConsole component
  return (
    <div style={{ display: 'none' }}></div>
  );
};

export default ResourceManager;