// Janus loader module for dynamic script loading
declare global {
  interface Window {
    Janus: any;
    adapter: any;
  }
}

let janusLoaded = false;
let janusLoadPromise: Promise<void> | null = null;

const loadScript = (src: string): Promise<void> => {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) {
      resolve();
      return;
    }

    const script = document.createElement('script');
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
    document.head.appendChild(script);
  });
};

export const loadJanus = (): Promise<void> => {
  if (janusLoaded && window.Janus) {
    return Promise.resolve();
  }

  if (janusLoadPromise) {
    return janusLoadPromise;
  }

  janusLoadPromise = (async () => {
    try {
      // Load adapter first
      await loadScript('/js/adapter.js');
      
      // Try to load local Janus, fallback to CDN
      try {
        await loadScript('/js/janus.js');
      } catch (error) {
        console.warn('Local Janus failed, trying CDN fallback...');
        await loadScript('https://cdn.jsdelivr.net/npm/janus-gateway@1.3.2/janus.js');
      }
      
      // Wait a bit for globals to be available
      await new Promise(resolve => setTimeout(resolve, 200));
      
      if (!window.Janus) {
        throw new Error('Janus not available after loading scripts');
      }
      
      janusLoaded = true;
    } catch (error) {
      janusLoadPromise = null;
      throw error;
    }
  })();

  return janusLoadPromise;
};

export const getJanus = () => {
  if (!window.Janus) {
    throw new Error('Janus not loaded. Call loadJanus() first.');
  }
  return window.Janus;
};