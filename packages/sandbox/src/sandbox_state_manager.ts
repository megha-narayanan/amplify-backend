import { SandboxStatus } from './sandbox.js';
import { LogLevel, Printer } from '@aws-amplify/cli-core';

/**
 * Manages the state of the sandbox and notifies listeners when the state changes.
 */
export class SandboxStateManager {
  private currentStatus: SandboxStatus = SandboxStatus.NONEXISTENT;
  private listeners: Array<(status: SandboxStatus) => void> = [];
  
  /**
   * Creates a new SandboxStateManager instance.
   * @param printer The printer to use for logging.
   */
  constructor(private readonly printer: Printer) {}
  
  /**
   * Gets the current status of the sandbox.
   * @returns The current sandbox status.
   */
  public getStatus(): SandboxStatus {
    return this.currentStatus;
  }
  
  /**
   * Updates the status of the sandbox and notifies all listeners.
   * @param newStatus The new sandbox status.
   */
  public updateStatus(newStatus: SandboxStatus): void {
    if (this.currentStatus !== newStatus) {
      this.printer.log(`Sandbox status changed from ${this.currentStatus} to ${newStatus}`, LogLevel.INFO);
      this.currentStatus = newStatus;
      this.notifyListeners();
    }
  }
  
  /**
   * Adds a listener that will be notified when the sandbox status changes.
   * @param listener The listener function to add.
   */
  public addListener(listener: (status: SandboxStatus) => void): void {
    this.listeners.push(listener);
    
    // Immediately notify the new listener of the current status
    try {
      listener(this.currentStatus);
    } catch (error) {
      this.printer.log(`Error in sandbox status listener: ${error}`, LogLevel.ERROR);
    }
  }
  
  /**
   * Removes a listener.
   * @param listener The listener function to remove.
   */
  public removeListener(listener: (status: SandboxStatus) => void): void {
    const index = this.listeners.indexOf(listener);
    if (index !== -1) {
      this.listeners.splice(index, 1);
    }
  }
  
  /**
   * Notifies all listeners of the current status.
   */
  private notifyListeners(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.currentStatus);
      } catch (error) {
        this.printer.log(`Error in sandbox status listener: ${error}`, LogLevel.ERROR);
      }
    }
  }
}
