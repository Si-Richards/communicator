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
    console.log(`Loading script: ${src}`);
    
    if (document.querySelector(`script[src="${src}"]`)) {
      console.log(`Script already exists: ${src}`);
      resolve();
      return;
    }

    const script = document.createElement('script');
    script.src = src;
    script.onload = () => {
      console.log(`Script loaded successfully: ${src}`);
      resolve();
    };
    script.onerror = () => {
      console.error(`Failed to load script: ${src}`);
      reject(new Error(`Failed to load script: ${src}`));
    };
    document.head.appendChild(script);
  });
};

const waitForGlobal = (globalName: string, timeout = 5000): Promise<any> => {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    
    const checkGlobal = () => {
      if (window[globalName as keyof Window]) {
        console.log(`Global ${globalName} is available`);
        resolve(window[globalName as keyof Window]);
        return;
      }
      
      if (Date.now() - startTime > timeout) {
        reject(new Error(`Timeout waiting for global ${globalName}`));
        return;
      }
      
      setTimeout(checkGlobal, 50);
    };
    
    checkGlobal();
  });
};

export const loadJanus = (): Promise<void> => {
  if (janusLoaded && window.Janus) {
    console.log('Janus already loaded');
    return Promise.resolve();
  }

  if (janusLoadPromise) {
    console.log('Janus loading in progress');
    return janusLoadPromise;
  }

  janusLoadPromise = (async () => {
    try {
      console.log('Starting Janus loading process');
      
      // Load adapter first
      await loadScript('/js/adapter.js');
      await waitForGlobal('adapter', 3000);
      console.log('Adapter loaded and available');
      
      // Try to load local Janus, fallback to CDN
      try {
        await loadScript('/js/janus.js');
        await waitForGlobal('Janus', 5000);
      } catch (error) {
        console.warn('Local Janus failed, trying CDN fallback...', error);
        try {
          await loadScript('https://janus.conf.meetecho.com/janus.js');
          await waitForGlobal('Janus', 5000);
        } catch (cdnError) {
          console.warn('Primary CDN failed, trying secondary...', cdnError);
          await loadScript('https://unpkg.com/janus-gateway@1.3.2/janus.js');
          await waitForGlobal('Janus', 5000);
        }
      }
      
      if (!window.Janus) {
        throw new Error('Janus not available after loading scripts');
      }
      
      console.log('Janus loaded successfully');
      janusLoaded = true;
    } catch (error) {
      console.error('Failed to load Janus:', error);
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