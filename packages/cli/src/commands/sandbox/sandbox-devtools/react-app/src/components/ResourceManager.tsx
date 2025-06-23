import React from 'react';
import { Socket } from 'socket.io-client';
import { useResourceManager, BackendResourcesData } from '../hooks/useResourceManager';

/**
 * Props for the ResourceManager component
 */
interface ResourceManagerProps {
  socket: Socket | null;
  onResourcesLoaded?: (data: BackendResourcesData) => void;
  sandboxStatus?: string;
}

/**
 * Component that manages backend resources
 * This is a non-visual component that handles resource loading and management
 */
const ResourceManager: React.FC<ResourceManagerProps> = ({
  socket,
  onResourcesLoaded,
  sandboxStatus
}) => {
  // Use the resource manager hook
  useResourceManager(socket, onResourcesLoaded, sandboxStatus);
  
  // This component doesn't render anything visible
  return <div style={{ display: 'none' }}></div>;
};

export default ResourceManager;
