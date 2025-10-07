/**
 * XMPP Stream Feature Parser
 * Parses <stream:features> element to detect server capabilities
 */

export interface StreamFeatures {
  streamManagement: boolean;
  streamManagementResume: boolean;
  bind: boolean;
  session: boolean;
  mechanisms: string[];
  compression: string[];
  csi: boolean; // Client State Indication
  carbons: boolean; // Message Carbons
}

/**
 * Parse stream features from the <stream:features> stanza
 * This is sent by the server after authentication
 */
export function parseStreamFeatures(stanza: any): StreamFeatures {
  const features: StreamFeatures = {
    streamManagement: false,
    streamManagementResume: false,
    bind: false,
    session: false,
    mechanisms: [],
    compression: [],
    csi: false,
    carbons: false,
  };

  if (!stanza) return features;

  // Check for Stream Management (XEP-0198)
  const sm = stanza.getChild('sm', 'urn:xmpp:sm:3');
  if (sm) {
    features.streamManagement = true;
    // Check if resume is supported
    features.streamManagementResume = sm.attrs?.optional === 'false' || true;
  }

  // Check for BIND (RFC 6120)
  if (stanza.getChild('bind', 'urn:ietf:params:xml:ns:xmpp-bind')) {
    features.bind = true;
  }

  // Check for Session (deprecated but still used)
  if (stanza.getChild('session', 'urn:ietf:params:xml:ns:xmpp-session')) {
    features.session = true;
  }

  // Check for SASL mechanisms
  const sasl = stanza.getChild('mechanisms', 'urn:ietf:params:xml:ns:xmpp-sasl');
  if (sasl) {
    const mechanisms = sasl.getChildren('mechanism');
    features.mechanisms = mechanisms.map((m: any) => m.text());
  }

  // Check for compression
  const compression = stanza.getChild('compression', 'http://jabber.org/features/compress');
  if (compression) {
    const methods = compression.getChildren('method');
    features.compression = methods.map((m: any) => m.text());
  }

  // Check for Client State Indication (XEP-0352)
  if (stanza.getChild('csi', 'urn:xmpp:csi:0')) {
    features.csi = true;
  }

  // Check for Message Carbons (XEP-0280)
  if (stanza.getChild('carbons', 'urn:xmpp:carbons:2')) {
    features.carbons = true;
  }

  return features;
}

/**
 * Log stream features for debugging
 */
export function logStreamFeatures(features: StreamFeatures): void {
  console.log('📡 Stream Features:', {
    'Stream Management (XEP-0198)': features.streamManagement ? '✅' : '❌',
    'SM Resume': features.streamManagementResume ? '✅' : '❌',
    'Resource Binding': features.bind ? '✅' : '❌',
    'Session': features.session ? '✅' : '❌',
    'SASL Mechanisms': features.mechanisms.join(', ') || 'none',
    'Compression': features.compression.join(', ') || 'none',
    'Client State Indication': features.csi ? '✅' : '❌',
    'Message Carbons': features.carbons ? '✅' : '❌',
  });
}
