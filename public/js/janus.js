// Janus Gateway JavaScript Library Loader
// This file loads the Janus library from a reliable CDN source

(function() {
    'use strict';
    
    // Check if Janus is already loaded
    if (window.Janus) {
        console.log('Janus already loaded');
        return;
    }
    
    console.log('Loading Janus Gateway from CDN...');
    
    // Create script element for Janus
    const script = document.createElement('script');
    script.src = 'https://unpkg.com/janus-gateway@1.3.1/dist/janus.umd.js';
    script.type = 'text/javascript';
    
    script.onload = function() {
        console.log('Janus Gateway loaded successfully from CDN');
        
        // Verify Janus is available
        if (window.Janus) {
            console.log('Janus object is available:', typeof window.Janus);
        } else {
            console.error('Janus object not found after loading');
        }
    };
    
    script.onerror = function(error) {
        console.error('Failed to load Janus from primary CDN, trying fallback...');
        
        // Fallback CDN
        const fallbackScript = document.createElement('script');
        fallbackScript.src = 'https://cdn.skypack.dev/janus-gateway@1.3.1';
        fallbackScript.type = 'text/javascript';
        
        fallbackScript.onload = function() {
            console.log('Janus Gateway loaded from fallback CDN');
        };
        
        fallbackScript.onerror = function(fallbackError) {
            console.error('Failed to load Janus from all CDN sources');
        };
        
        document.head.appendChild(fallbackScript);
    };
    
    // Append script to head
    document.head.appendChild(script);
    
})();