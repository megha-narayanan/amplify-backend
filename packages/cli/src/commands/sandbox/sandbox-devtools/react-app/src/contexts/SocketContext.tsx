import React, { createContext, useContext } from 'react';
import { Socket } from 'socket.io-client';

// Create a context for the socket
const SocketContext = createContext<Socket | null>(null);

// Hook to use the socket context
export const useSocket = () => useContext(SocketContext);

// Provider component
export const SocketProvider: React.FC<{ socket: Socket | null; children: React.ReactNode }> = ({ 
  socket, 
  children 
}) => {
  return (
    <SocketContext.Provider value={socket}>
      {children}
    </SocketContext.Provider>
  );
};