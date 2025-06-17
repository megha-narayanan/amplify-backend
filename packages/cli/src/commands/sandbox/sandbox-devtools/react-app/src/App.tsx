import { useState, useEffect, useRef } from 'react';
import ConsoleViewer from './components/ConsoleViewer';
import Header from './components/Header';
import ResourceConsole from './components/ResourceConsole';
import DeploymentProgress from './components/DeploymentProgress';
import SandboxOptionsModal, { SandboxOptions } from './components/SandboxOptionsModal';
import { io, Socket } from 'socket.io-client';
import { 
  AppLayout, 
  Tabs, 
  ContentLayout,
  SpaceBetween,
  Alert
} from '@cloudscape-design/components';
import '@cloudscape-design/global-styles/index.css';

interface LogEntry {
  id: string;
  timestamp: string;
  level: string;
  message: string;
}

interface SandboxStatusData {
  status: 'running' | 'stopped' | 'nonexistent' | 'deploying';
  error?: string;
  identifier?: string;
  stackStatus?: string;
}

function App() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<Socket | null>(null);
  const [activeTabId, setActiveTabId] = useState('logs');
  const [sandboxStatus, setSandboxStatus] = useState<'running' | 'stopped' | 'nonexistent' | 'unknown' | 'deploying'>('unknown');
  const [sandboxIdentifier, setSandboxIdentifier] = useState<string | undefined>(undefined);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [showOptionsModal, setShowOptionsModal] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const statusRequestedRef = useRef<boolean>(false);
  const [deploymentInProgress, setDeploymentInProgress] = useState<boolean>(false);

  // Filter out deployment progress messages from logs
  const isDeploymentProgressMessage = (message: string): boolean => {
    return (
      message.includes('_IN_PROGRESS') ||
      message.includes('CREATE_') ||
      message.includes('DELETE_') ||
      message.includes('UPDATE_') ||
      message.includes('Deployment in progress')
    );
  };

  // Filter logs to exclude deployment progress messages
  const filteredLogs = logs.filter(log => !isDeploymentProgressMessage(log.message));

  useEffect(() => {
    // Connect to Socket.IO server using the current hostname and port
    const currentUrl = window.location.origin;
    console.log('Connecting to socket at:', currentUrl);
    
    const socket = io(currentUrl, {
      reconnectionAttempts: 5,
      timeout: 10000
    });
    socketRef.current = socket;

    // Handle connection events
    socket.on('connect', () => {
      console.log('Socket connected successfully');
      setConnected(true);
      setConnectionError(null);
      
      // Explicitly request sandbox status immediately after connection
      if (!statusRequestedRef.current) {
        console.log('Requesting sandbox status on initial connection');
        socket.emit('getSandboxStatus');
        statusRequestedRef.current = true;
        
        // Add a log entry
        setLogs(prev => [...prev, {
          id: Date.now().toString(),
          timestamp: new Date().toISOString(),
          level: 'INFO',
          message: 'DevTools connected to Amplify Sandbox, requesting status...'
        }]);
      } else {
        setLogs(prev => [...prev, {
          id: Date.now().toString(),
          timestamp: new Date().toISOString(),
          level: 'INFO',
          message: 'DevTools reconnected to Amplify Sandbox'
        }]);
      }
    });

    // Handle connection errors
    socket.on('connect_error', (error) => {
      console.error('Socket connection error:', error);
      setConnectionError(`Connection error: ${error.message}`);
      setLogs(prev => [...prev, {
        id: Date.now().toString(),
        timestamp: new Date().toISOString(),
        level: 'ERROR',
        message: `Connection error: ${error.message}`
      }]);
    });

    socket.on('connect_timeout', () => {
      console.error('Socket connection timeout');
      setConnectionError('Connection timeout');
      setLogs(prev => [...prev, {
        id: Date.now().toString(),
        timestamp: new Date().toISOString(),
        level: 'ERROR',
        message: 'Connection timeout'
      }]);
    });

    // Handle log messages
    socket.on('log', (data) => {
      setLogs(prev => [...prev, {
        id: Date.now().toString(),
        timestamp: data.timestamp,
        level: data.level,
        message: data.message
      }]);
    });

    // Handle deployment in progress events
    socket.on('deploymentInProgress', () => {
      setDeploymentInProgress(true);
      // Automatically switch to deployment tab when deployment starts
      setActiveTabId('deployment');
    });
    
    // Handle deployment completed events
    socket.on('deploymentCompleted', () => {
      setDeploymentInProgress(false);
    });

    // Handle sandbox status updates
    socket.on('sandboxStatus', (data: SandboxStatusData) => {
      console.log(`Status update received: ${data.status}`, data);
      
      // Update the status
      setSandboxStatus(data.status);
      
      // If status is deploying, show deployment tab
      if (data.status === 'deploying') {
        setDeploymentInProgress(true);
        setActiveTabId('deployment');
      }
      
      // Update the sandbox identifier if provided
      if (data.identifier) {
        setSandboxIdentifier(data.identifier);
      } else if (data.status === 'nonexistent') {
        // Clear identifier for nonexistent sandbox
        setSandboxIdentifier(undefined);
      }
      
      if (data.error) {
        setStatusError(data.error);
        setLogs(prev => [...prev, {
          id: Date.now().toString(),
          timestamp: new Date().toISOString(),
          level: 'ERROR',
          message: `Sandbox error: ${data.error}`
        }]);
      } else {
        setStatusError(null);
        setLogs(prev => [...prev, {
          id: Date.now().toString(),
          timestamp: new Date().toISOString(),
          level: 'INFO',
          message: data.identifier 
            ? `Sandbox status: ${data.status} (identifier: ${data.identifier})`
            : `Sandbox status: ${data.status}`
        }]);
      }
    });

    // Handle disconnection
    socket.on('disconnect', (reason) => {
      console.log(`Socket disconnected: ${reason}`);
      setConnected(false);
      setSandboxStatus('unknown');
      statusRequestedRef.current = false; // Reset so we request status on reconnect
      
      // Add to logs
      setLogs(prev => [...prev, {
        id: Date.now().toString(),
        timestamp: new Date().toISOString(),
        level: 'WARNING',
        message: `Disconnected from server: ${reason}`
      }]);
      
      // If not a normal disconnect, set error
      if (reason !== 'io client disconnect') {
        setConnectionError(`Connection lost: ${reason}`);
      }
    });

    // Set up a periodic ping to check connection health
    const pingInterval = setInterval(() => {
      if (socket.connected) {
        socket.emit('ping', {}, (response: any) => {
          if (!response || response.error) {
            console.warn('Ping failed:', response?.error || 'No response');
          }
        });
      }
    }, 30000); // Every 30 seconds

    // Clean up on unmount
    return () => {
      clearInterval(pingInterval);
      socket.disconnect();
    };
  }, []);

  // Effect to periodically check sandbox status if unknown
  useEffect(() => {
    if (!socketRef.current || !socketRef.current.connected) return;
    
    // If status is unknown, request it periodically
    if (sandboxStatus === 'unknown') {
      const statusCheckInterval = setInterval(() => {
        console.log('Requesting sandbox status due to unknown state');
        socketRef.current?.emit('getSandboxStatus');
        
        // Add a log entry to show we're still trying
        setLogs(prev => [...prev, {
          id: Date.now().toString(),
          timestamp: new Date().toISOString(),
          level: 'INFO',
          message: 'Requesting sandbox status...'
        }]);
      }, 5000); // Check every 5 seconds
      
      return () => clearInterval(statusCheckInterval);
    }
  }, [sandboxStatus]);

  // Force a status check if we've been in unknown state for too long
  useEffect(() => {
    if (sandboxStatus === 'unknown' && connected && socketRef.current) {
      const forceStatusCheck = setTimeout(() => {
        console.log('Forcing sandbox status check after timeout');
        socketRef.current?.emit('getSandboxStatus');
      }, 2000); // Force a check after 2 seconds
      
      return () => clearTimeout(forceStatusCheck);
    }
  }, [sandboxStatus, connected]);

  const clearLogs = () => {
    setLogs([]);
  };

  const startSandbox = () => {
    // Show the options modal instead of starting the sandbox directly
    setShowOptionsModal(true);
  };
  
  const handleStartSandboxWithOptions = (options: SandboxOptions) => {
    if (socketRef.current) {
      // Close the modal
      setShowOptionsModal(false);
      
      // Set status to deploying to show loading state
      setSandboxStatus('deploying');
      setDeploymentInProgress(true);
      setActiveTabId('deployment');
      
      // Emit the startSandbox event with options
      socketRef.current.emit('startSandboxWithOptions', options);
      
      // Log the action with options details
      const optionsText = Object.keys(options).length > 0 
        ? ` with options: ${JSON.stringify(options)}`
        : '';
      
      setLogs(prev => [...prev, {
        id: Date.now().toString(),
        timestamp: new Date().toISOString(),
        level: 'INFO',
        message: `Requesting to start sandbox${optionsText}...`
      }]);
    }
  };

  const stopSandbox = () => {
    if (socketRef.current) {
      socketRef.current.emit('stopSandbox');
      setLogs(prev => [...prev, {
        id: Date.now().toString(),
        timestamp: new Date().toISOString(),
        level: 'INFO',
        message: 'Requesting to stop sandbox...'
      }]);
    }
  };
  
  const deleteSandbox = () => {
    if (socketRef.current) {
      socketRef.current.emit('deleteSandbox');
      setDeploymentInProgress(true);
      setActiveTabId('deployment');
      setLogs(prev => [...prev, {
        id: Date.now().toString(),
        timestamp: new Date().toISOString(),
        level: 'INFO',
        message: 'Requesting to delete sandbox...'
      }]);
    }
  };

  const mainContent = (
    <ContentLayout
      header={
        <Header 
          connected={connected} 
          onClear={clearLogs} 
          sandboxStatus={sandboxStatus}
          sandboxIdentifier={sandboxIdentifier}
          onStartSandbox={startSandbox}
          onStopSandbox={stopSandbox}
          onDeleteSandbox={deleteSandbox}
        />
      }
    >
      {connectionError && (
        <Alert type="error" header="Connection Error" dismissible onDismiss={() => setConnectionError(null)}>
          {connectionError}
        </Alert>
      )}
      
      {statusError && (
        <Alert type="error" header="Sandbox Error">
          {statusError}
        </Alert>
      )}
      
      <SpaceBetween size="l">
        <Tabs
          activeTabId={activeTabId}
          onChange={({ detail }) => setActiveTabId(detail.activeTabId)}
          tabs={[
            {
              id: 'logs',
              label: 'Console Logs',
              content: <ConsoleViewer logs={filteredLogs} />
            },
            {
              id: 'resources',
              label: 'Resources',
              content: <ResourceConsole socket={socketRef.current} sandboxStatus={sandboxStatus} />
            },
            {
              id: 'deployment',
              label: deploymentInProgress ? 'Deployment Progress ⚡' : 'Deployment Progress',
              content: <DeploymentProgress socket={socketRef.current} visible={true} />
            }
          ]}
        />
      </SpaceBetween>
    </ContentLayout>
  );

  return (
    <>
      <AppLayout
        content={mainContent}
        navigationHide={true}
        toolsHide={true}
        maxContentWidth={1800}
        contentType="default"
        headerSelector="#header"
      />
      
      <SandboxOptionsModal
        visible={showOptionsModal}
        onDismiss={() => setShowOptionsModal(false)}
        onConfirm={handleStartSandboxWithOptions}
      />
    </>
  );
}

export default App;