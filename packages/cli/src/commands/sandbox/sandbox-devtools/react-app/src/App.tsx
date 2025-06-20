import { useState, useEffect, useRef } from 'react';
import ConsoleViewer from './components/ConsoleViewer';
import Header from './components/Header';
import ResourceConsole from './components/ResourceConsole';
import DeploymentProgress from './components/DeploymentProgress';
import SandboxOptionsModal, { SandboxOptions } from './components/SandboxOptionsModal';
import { io, Socket } from 'socket.io-client';
import { SocketProvider } from './contexts/SocketContext';
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
  deploymentCompleted?: boolean;
  message?: string;
  timestamp?: string;
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
  
  // Determine if deployment is in progress based on sandbox status
  const deploymentInProgress = sandboxStatus === 'deploying';

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
      console.log('Socket connected with ID:', socket.id);
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
      setConnectionError('true');
      setLogs(prev => [...prev, {
        id: Date.now().toString(),
        timestamp: new Date().toISOString(),
        level: 'ERROR',
        message: `Connection error: ${error.message}`
      }]);
    });

    socket.on('connect_timeout', () => {
      console.error('Socket connection timeout');
      setConnectionError('true');
      setLogs(prev => [...prev, {
        id: Date.now().toString(),
        timestamp: new Date().toISOString(),
        level: 'ERROR',
        message: 'Connection timeout'
      }]);
    });

// Add reconnection logging
socket.on('reconnect', (attemptNumber) => {
  console.log(`Socket reconnected after ${attemptNumber} attempts`);
  // Request sandbox status after reconnection
  socket.emit('getSandboxStatus');
});

socket.on('reconnect_attempt', (attemptNumber) => {
  console.log(`Socket reconnection attempt ${attemptNumber}`);
});

socket.on('reconnect_error', (error) => {
  console.log('Socket reconnection error:', error);
});

socket.on('reconnect_failed', () => {
  console.log('Socket reconnection failed');
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
  // Request saved deployment progress when connected
  socket.on('connect', () => {
    // Request saved deployment progress
    socket.emit('getSavedDeploymentProgress');
  });

    // Handle sandbox status updates
    socket.on('sandboxStatus', (data: SandboxStatusData) => {
      console.log(`[CLIENT] Status update received: ${data.status}`, data);
      
      // Update the status
      setSandboxStatus(data.status);
      
      // Status is already updated by setSandboxStatus(data.status) above
      console.log(`[CLIENT] Sandbox status updated to: ${data.status}`);
      
      // Update the sandbox identifier if provided
      if (data.identifier) {
        setSandboxIdentifier(data.identifier);
      } else if (data.status === 'nonexistent') {
        // Clear identifier for nonexistent sandbox
        setSandboxIdentifier(undefined);
      }
      
      // Handle deployment completion information
      if (data.deploymentCompleted) {
        console.log('[CLIENT] Deployment completed event received via sandboxStatus:', data);
        
        // Add deployment completion log
        setLogs(prev => [...prev, {
          id: Date.now().toString(),
          timestamp: data.timestamp || new Date().toISOString(),
          level: data.error ? 'ERROR' : 'SUCCESS',
          message: data.message || (data.error ? 'Deployment failed' : 'Deployment completed successfully')
        }]);
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
        
        // Only add a general status log if this isn't a deployment completion event
        // to avoid duplicate logs
        if (!data.deploymentCompleted) {
          setLogs(prev => [...prev, {
            id: Date.now().toString(),
            timestamp: new Date().toISOString(),
            level: 'INFO',
            message: data.identifier 
              ? `Sandbox status: ${data.status} (identifier: ${data.identifier})`
              : `Sandbox status: ${data.status}`
          }]);
        }
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
        setConnectionError('true');
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
        <Alert 
          type="error" 
          header="DevTools process was interrupted" 
          dismissible={false}
        >
          Please restart it on the command line using: <strong>npx ampx sandbox devtools</strong>
        </Alert>
      )}
      
      {statusError && (
        <Alert type="error" header="Sandbox Error">
          {statusError}
        </Alert>
      )}
      
      {deploymentInProgress && (
        <Alert type="info" header="Deployment in Progress" dismissible onDismiss={() => {}}>
          A sandbox deployment is currently in progress. You can view the deployment details in the Console Logs tab.
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
              content: (
                <SpaceBetween size="l">
                  <DeploymentProgress socket={socketRef.current} visible={deploymentInProgress} />
                  <ConsoleViewer logs={filteredLogs} />
                </SpaceBetween>
              )
            },
            {
              id: 'resources',
              label: 'Resources',
              content: <ResourceConsole socket={socketRef.current} sandboxStatus={sandboxStatus} />
            }
          ]}
        />
      </SpaceBetween>
    </ContentLayout>
  );

  return (
    <SocketProvider socket={socketRef.current}>
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
    </SocketProvider>
  );
}

export default App;
