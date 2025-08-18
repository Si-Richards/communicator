import { logger } from './logger';

export interface NotificationOptions {
  title: string;
  body?: string;
  icon?: string;
  tag?: string;
  requireInteraction?: boolean;
}

class NotificationManager {
  private isSupported(): boolean {
    return 'Notification' in window;
  }

  getPermission(): NotificationPermission {
    if (!this.isSupported()) {
      return 'denied';
    }
    return Notification.permission;
  }

  async requestPermission(): Promise<NotificationPermission> {
    if (!this.isSupported()) {
      logger.warn('Notifications not supported in this browser', 'NotificationManager');
      return 'denied';
    }

    if (this.getPermission() === 'default') {
      const permission = await Notification.requestPermission();
      logger.info(`Notification permission: ${permission}`, 'NotificationManager');
      return permission;
    }

    return this.getPermission();
  }

  show(options: NotificationOptions): Notification | null {
    if (!this.isSupported() || this.getPermission() !== 'granted') {
      logger.warn('Cannot show notification - not supported or permission denied', 'NotificationManager');
      return null;
    }

    try {
      const notification = new Notification(options.title, {
        body: options.body,
        icon: options.icon || '/favicon.ico',
        tag: options.tag,
        requireInteraction: options.requireInteraction,
      });

      // Auto-close after 10 seconds unless requireInteraction is true
      if (!options.requireInteraction) {
        setTimeout(() => {
          notification.close();
        }, 10000);
      }

      // Focus window when notification is clicked
      notification.onclick = () => {
        window.focus();
        notification.close();
      };

      logger.info(`Notification shown: ${options.title}`, 'NotificationManager');
      return notification;
    } catch (error) {
      logger.error(`Failed to show notification: ${error}`, 'NotificationManager');
      return null;
    }
  }

  /**
   * Shows a notification only if the app is hidden (minimized, in background, or tab not active)
   */
  showWhenHidden(options: NotificationOptions): Notification | null {
    const isHidden = document.hidden || !document.hasFocus();
    
    if (isHidden) {
      return this.show(options);
    }
    
    logger.debug('App is visible, skipping notification', 'NotificationManager');
    return null;
  }

  /**
   * Shows a test notification to verify functionality
   */
  showTest(): Notification | null {
    return this.show({
      title: 'Test Notification',
      body: 'Desktop notifications are working correctly!',
      tag: 'test-notification',
    });
  }
}

export const notificationManager = new NotificationManager();