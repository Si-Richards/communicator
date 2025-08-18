import { useEffect } from 'react';
import { notificationManager } from '@/lib/notificationManager';
import { useSettings } from '@/contexts/SettingsContext';
import { logger } from '@/lib/logger';

export const NotificationBootstrap = ({ children }: { children: React.ReactNode }) => {
  const { settings } = useSettings();

  useEffect(() => {
    const initializeNotifications = async () => {
      if (!settings.notifications.enabled) {
        logger.debug('Notifications disabled in settings', 'NotificationBootstrap');
        return;
      }

      const permission = notificationManager.getPermission();
      logger.info(`Current notification permission: ${permission}`, 'NotificationBootstrap');

      // Request permission if default and askOnStartup is enabled
      if (permission === 'default' && settings.notifications.askOnStartup) {
        logger.info('Requesting notification permission on startup', 'NotificationBootstrap');
        const newPermission = await notificationManager.requestPermission();
        logger.info(`Notification permission result: ${newPermission}`, 'NotificationBootstrap');
      }
    };

    initializeNotifications();
  }, [settings.notifications.enabled, settings.notifications.askOnStartup]);

  return <>{children}</>;
};