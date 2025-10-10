/**
 * Centralized XMPP Error Handler
 * Maps XMPP errors to user-friendly messages
 */

export interface XmppError {
  code?: string;
  condition?: string;
  text?: string;
  type?: string;
}

export interface FormattedError {
  title: string;
  message: string;
  action?: string;
}

export class XmppErrorHandler {
  static formatError(error: any): FormattedError {
    if (typeof error === 'string') {
      return {
        title: 'Error',
        message: error,
      };
    }

    const xmppError = error as XmppError;

    // Handle XMPP standard error conditions
    switch (xmppError.condition) {
      case 'service-unavailable':
        return {
          title: 'Service Unavailable',
          message: 'The requested service is currently unavailable. Please try again later.',
          action: 'Check your connection and try again',
        };

      case 'item-not-found':
        return {
          title: 'Not Found',
          message: 'The requested item could not be found.',
          action: 'Verify the JID or room name and try again',
        };

      case 'forbidden':
        return {
          title: 'Access Denied',
          message: 'You do not have permission to perform this action.',
          action: 'Contact the room administrator for access',
        };

      case 'not-authorized':
        return {
          title: 'Not Authorized',
          message: 'Authentication failed or insufficient permissions.',
          action: 'Check your credentials and permissions',
        };

      case 'not-acceptable':
        return {
          title: 'Invalid Request',
          message: 'The server rejected your request.',
          action: 'Check your input and try again',
        };

      case 'conflict':
        return {
          title: 'Conflict',
          message: 'A resource with this name already exists.',
          action: 'Try a different name or nickname',
        };

      case 'registration-required':
        return {
          title: 'Registration Required',
          message: 'You must be registered to perform this action.',
          action: 'Register an account first',
        };

      case 'remote-server-not-found':
        return {
          title: 'Server Not Found',
          message: 'Could not connect to the remote server.',
          action: 'Verify the server address',
        };

      case 'remote-server-timeout':
        return {
          title: 'Server Timeout',
          message: 'The remote server did not respond in time.',
          action: 'Try again later',
        };

      case 'resource-constraint':
        return {
          title: 'Resource Limit',
          message: 'A resource limit has been reached.',
          action: 'Wait a moment and try again',
        };

      case 'feature-not-implemented':
        return {
          title: 'Feature Not Supported',
          message: 'This feature is not supported by the server.',
          action: 'Contact your server administrator',
        };

      default:
        // Use error text if available
        if (xmppError.text) {
          return {
            title: 'Error',
            message: xmppError.text,
          };
        }

        // Fallback to generic error
        return {
          title: 'An Error Occurred',
          message: error.message || 'An unexpected error occurred. Please try again.',
        };
    }
  }

  static formatRoomJoinError(error: any, roomJid: string): FormattedError {
    const baseError = this.formatError(error);

    // Add room-specific context
    if (baseError.title === 'Access Denied') {
      return {
        ...baseError,
        message: `You cannot join the room "${roomJid}". The room may be members-only or you may be banned.`,
      };
    }

    if (baseError.title === 'Not Found') {
      return {
        ...baseError,
        message: `The room "${roomJid}" does not exist.`,
        action: 'Create this room or check the room JID',
      };
    }

    if (baseError.title === 'Conflict') {
      return {
        ...baseError,
        message: 'Your nickname is already in use in this room.',
        action: 'Choose a different nickname',
      };
    }

    return baseError;
  }

  static formatUserSearchError(error: any): FormattedError {
    const baseError = this.formatError(error);

    if (baseError.title === 'Service Unavailable') {
      return {
        title: 'Search Unavailable',
        message: 'User search is not available on this server.',
        action: 'Try browsing your contact list instead',
      };
    }

    return baseError;
  }
}

export const xmppErrorHandler = new XmppErrorHandler();
