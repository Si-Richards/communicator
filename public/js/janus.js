// Load Janus from the CDN that was working
console.log('Loading Janus Gateway library locally...');

// Dynamically load the working CDN version as fallback
if (!window.Janus) {
  const script = document.createElement('script');
  script.src = 'https://cdn.jsdelivr.net/npm/janus-gateway@1.3.2/janus.js';
  script.onload = () => {
    console.log('Janus loaded from CDN fallback');
  };
  script.onerror = () => {
    console.error('Failed to load Janus from CDN');
  };
  document.head.appendChild(script);
}

// Temporary message
console.log('Janus loader initialized with CDN fallback');