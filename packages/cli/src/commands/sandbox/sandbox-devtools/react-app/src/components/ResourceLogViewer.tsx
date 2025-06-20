import React, { useState, useEffect, useRef } from 'react';
import { useSocket } from '../contexts/SocketContext';
import {
  Box,
  Button,
  SpaceBetween,
  StatusIndicator,
  Modal,
  TextContent
} from '@cloudscape-design/components';

interface LogEntry {
  timestamp: string;
  message: string;
}

interface ResourceLogViewerProps {
  resourceId: string;
  resourceName: string;
  onClose: () => void;
}

const ResourceLogViewer: React.FC<ResourceLogViewerProps> = ({ resourceId, resourceName, onClose }) => {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [status, setStatus] = useState<'inactive' | 'starting' | 'active' | 'error'>('inactive');
  const [error, setError] = useState<string | null>(null);
  const logContainerRef = useRef<HTMLDivElement>(null);
  const socket = useSocket();

  useEffect(() => {
    if (!socket) return;

    // Request saved logs first
    socket.emit('getSavedResourceLogs', { resourceId });

    // Start log streaming
    socket.emit('startResourceLogs', { resourceId });

    // Listen for log stream status updates
    const handleLogStreamStatus = (data: { resourceId: string; status: string; }) => {
      if (data.resourceId === resourceId) {
        if (data.status === 'starting') {
          setStatus('starting');
        } else if (data.status === 'active' || data.status === 'already-active') {
          setStatus('active');
        } else if (data.status === 'stopped') {
          setStatus('inactive');
        }
      }
    };

    // Listen for log entries
    const handleResourceLogs = (data: { resourceId: string; logs: LogEntry[]; }) => {
      if (data.resourceId === resourceId) {
        setLogs(prevLogs => [...prevLogs, ...data.logs]);
      }
    };

    // Listen for saved logs
    const handleSavedResourceLogs = (data: { resourceId: string; logs: LogEntry[]; }) => {
      if (data.resourceId === resourceId) {
        setLogs(data.logs);
      }
    };

    // Listen for errors
    const handleLogStreamError = (data: { resourceId: string; error: string; }) => {
      if (data.resourceId === resourceId) {
        setStatus('error');
        setError(data.error);
      }
    };

    socket.on('logStreamStatus', handleLogStreamStatus);
    socket.on('resourceLogs', handleResourceLogs);
    socket.on('savedResourceLogs', handleSavedResourceLogs);
    socket.on('logStreamError', handleLogStreamError);

    return () => {
      // Clean up event listeners
      socket.off('logStreamStatus', handleLogStreamStatus);
      socket.off('resourceLogs', handleResourceLogs);
      socket.off('savedResourceLogs', handleSavedResourceLogs);
      socket.off('logStreamError', handleLogStreamError);
      
      // Stop log streaming when component unmounts
      socket.emit('stopResourceLogs', { resourceId });
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

  return (
    <Modal
      visible={true}
      onDismiss={onClose}
      header={resourceName + " Logs"}
      size="large"
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button 
              variant="primary" 
              onClick={() => {
                if (socket) socket.emit('stopResourceLogs', { resourceId });
                onClose();
              }}
            >
              Close
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      <SpaceBetween direction="vertical" size="m">
        {status === 'starting' && (
          <StatusIndicator type="in-progress">Loading logs...</StatusIndicator>
        )}
        {status === 'active' && (
          <StatusIndicator type="success">Live logs streaming</StatusIndicator>
        )}
        {status === 'error' && (
          <StatusIndicator type="error">Error: {error}</StatusIndicator>
        )}
        
        <div
          ref={logContainerRef}
          style={{
            height: '400px',
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
          {logs.length === 0 ? (
            <TextContent>
              <p style={{ color: '#888' }}>No logs available</p>
            </TextContent>
          ) : (
            logs.map((log, index) => (
              <div key={index}>
                <span style={{ color: '#888' }}>[{formatTimestamp(log.timestamp)}]</span> {log.message}
              </div>
            ))
          )}
        </div>
        
        <TextContent>
          <p>{logs.length} log entries</p>
        </TextContent>
      </SpaceBetween>
    </Modal>
  );
};

export default ResourceLogViewer;