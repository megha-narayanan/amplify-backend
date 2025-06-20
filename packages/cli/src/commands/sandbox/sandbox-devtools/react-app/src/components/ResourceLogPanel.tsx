import React, { useState, useEffect, useRef } from 'react';
import { Socket } from 'socket.io-client';
import {
  Box,
  Button,
  SpaceBetween,
  StatusIndicator,
  TextContent,
  Input,
  FormField,
  Header,
  Modal
} from '@cloudscape-design/components';

interface LogEntry {
  timestamp: string;
  message: string;
}

interface ResourceLogPanelProps {
  resourceId: string;
  resourceName: string;
  resourceType: string;
  onClose: () => void;
  socket: Socket | null;
}

const ResourceLogPanel: React.FC<ResourceLogPanelProps> = ({ 
  resourceId, 
  resourceName, 
  resourceType,
  onClose,
  socket
}) => {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const logContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!socket) return;

    console.log(`[CLIENT] ResourceLogPanel: Initializing for resource ${resourceId}`);
    
    // Request saved logs when panel opens
    socket.emit('viewResourceLogs', { resourceId });

    // Check if this resource is already being logged
    socket.emit('getActiveLogStreams');

    // Listen for log stream status updates
    const handleLogStreamStatus = (data: { resourceId: string; status: string; }) => {
      if (data.resourceId === resourceId) {
        console.log(`[CLIENT] ResourceLogPanel: Log stream status update for ${resourceId}: ${data.status}`);
        setIsRecording(data.status === 'active' || data.status === 'already-active');
      }
    };

    // Listen for active log streams
    const handleActiveLogStreams = (streams: string[]) => {
      console.log(`[CLIENT] ResourceLogPanel: Active log streams: ${streams.join(', ')}`);
      setIsRecording(streams.includes(resourceId));
    };

    // Listen for log entries
    const handleResourceLogs = (data: { resourceId: string; logs: LogEntry[]; }) => {
      if (data.resourceId === resourceId) {
        console.log(`[CLIENT] ResourceLogPanel: Received ${data.logs.length} new log entries for ${resourceId}`);
        setLogs(prevLogs => [...prevLogs, ...data.logs]);
      }
    };

    // Listen for saved logs
    const handleSavedResourceLogs = (data: { resourceId: string; logs: LogEntry[]; }) => {
      if (data.resourceId === resourceId) {
        console.log(`[CLIENT] ResourceLogPanel: Loaded ${data.logs.length} saved log entries for ${resourceId}`);
        setLogs(data.logs);
      }
    };

    // Listen for errors
    const handleLogStreamError = (data: { resourceId: string; error: string; }) => {
      if (data.resourceId === resourceId) {
        console.error(`[CLIENT] ResourceLogPanel: Error for ${resourceId}: ${data.error}`);
        setError(data.error);
      }
    };

    socket.on('logStreamStatus', handleLogStreamStatus);
    socket.on('activeLogStreams', handleActiveLogStreams);
    socket.on('resourceLogs', handleResourceLogs);
    socket.on('savedResourceLogs', handleSavedResourceLogs);
    socket.on('logStreamError', handleLogStreamError);

    return () => {
      console.log(`[CLIENT] ResourceLogPanel: Cleaning up for resource ${resourceId}`);
      // Clean up event listeners
      socket.off('logStreamStatus', handleLogStreamStatus);
      socket.off('activeLogStreams', handleActiveLogStreams);
      socket.off('resourceLogs', handleResourceLogs);
      socket.off('savedResourceLogs', handleSavedResourceLogs);
      socket.off('logStreamError', handleLogStreamError);
    };
  }, [socket, resourceId]);

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs]);

  const formatTimestamp = (timestamp: string) => {
    try {
      const date = new Date(timestamp);
      return date.toLocaleTimeString();
    } catch (e) {
      return timestamp;
    }
  };

  // Filter logs based on search query
  const filteredLogs = logs.filter(log => 
    searchQuery === '' || 
    log.message.toLowerCase().includes(searchQuery.toLowerCase()) ||
    formatTimestamp(log.timestamp).toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Toggle recording
  const toggleRecording = () => {
    if (!socket) return;
    
    console.log(`[CLIENT] ResourceLogPanel: Toggling recording for ${resourceId} to ${!isRecording}`);
    socket.emit('toggleResourceLogging', {
      resourceId,
      resourceType,
      startLogging: !isRecording
    });
    
    // After toggling, request updated active log streams to ensure all components are in sync
    setTimeout(() => {
      socket.emit('getActiveLogStreams');
    }, 100);
  };

  return (
    <Modal
      visible={true}
      onDismiss={onClose}
      size="large"
      header={
        <Header
          variant="h2"
          actions={
            <SpaceBetween direction="horizontal" size="xs">
              <Button 
                onClick={toggleRecording} 
                variant={isRecording ? "normal" : "primary"}
              >
                {isRecording ? "Stop Recording" : "Start Recording"}
              </Button>
            </SpaceBetween>
          }
        >
          {resourceName} Logs
        </Header>
      }
      footer={
        <Box float="right">
          <Button onClick={onClose} variant="primary">
            Close
          </Button>
        </Box>
      }
    >
      <SpaceBetween direction="vertical" size="m">
        {isRecording ? (
          <StatusIndicator type="success">Recording logs</StatusIndicator>
        ) : (
          <StatusIndicator type="info">Not recording logs</StatusIndicator>
        )}
        {error && (
          <StatusIndicator type="error">Error: {error}</StatusIndicator>
        )}
        
        <FormField label="Search logs">
          <Input
            value={searchQuery}
            onChange={({ detail }) => setSearchQuery(detail.value)}
            placeholder="Search in logs..."
          />
        </FormField>
        
        <div
          ref={logContainerRef}
          style={{
            height: '60vh',
            overflowY: 'auto',
            fontFamily: 'monospace',
            whiteSpace: 'pre-wrap',
            fontSize: '14px',
            backgroundColor: '#000',
            color: '#fff',
            padding: '10px',
            borderRadius: '4px'
          }}
        >
          {filteredLogs.length === 0 ? (
            <TextContent>
              <p style={{ color: '#888' }}>
                {searchQuery ? 'No matching logs found' : 'No logs available'}
              </p>
            </TextContent>
          ) : (
            filteredLogs.map((log, index) => (
              <div key={index}>
                <span style={{ color: '#888' }}>[{formatTimestamp(log.timestamp)}]</span> {log.message}
              </div>
            ))
          )}
        </div>
        
        <TextContent>
          <p>{filteredLogs.length} log entries {searchQuery && `(filtered from ${logs.length})`}</p>
        </TextContent>
      </SpaceBetween>
    </Modal>
  );
};

export default ResourceLogPanel;
