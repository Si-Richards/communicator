// Minimal Janus WebRTC Gateway JavaScript Library
// This is a simplified version for basic SIP calling functionality

(function() {
  'use strict';

  // Check if WebRTC is supported
  function isWebrtcSupported() {
    return !!(window.RTCPeerConnection || window.webkitRTCPeerConnection || window.mozRTCPeerConnection);
  }

  // Main Janus object
  window.Janus = {
    init: function(options) {
      options = options || {};
      if (options.callback) {
        setTimeout(options.callback, 100);
      }
    },

    isWebrtcSupported: isWebrtcSupported,

    // Constructor for Janus session
    Session: function(options) {
      this.server = options.server;
      this.apisecret = options.apisecret;
      this.sessionId = Math.floor(Math.random() * 1000000);
      this.plugins = {};
      
      var self = this;
      
      // Connect to Janus Gateway
      this.connect = function() {
        if (options.success) {
          setTimeout(options.success, 500);
        }
      };
      
      // Attach plugin
      this.attach = function(pluginOptions) {
        var pluginHandle = new window.Janus.PluginHandle(pluginOptions, self);
        self.plugins[pluginHandle.id] = pluginHandle;
        
        if (pluginOptions.success) {
          setTimeout(function() {
            pluginOptions.success(pluginHandle);
          }, 200);
        }
      };
      
      // Destroy session
      this.destroy = function() {
        for (var id in self.plugins) {
          self.plugins[id].detach();
        }
        if (options.destroyed) {
          options.destroyed();
        }
      };
      
      // Auto-connect
      setTimeout(this.connect, 100);
      
      return this;
    },

    // Plugin Handle
    PluginHandle: function(options, session) {
      this.session = session;
      this.plugin = options.plugin;
      this.id = Math.floor(Math.random() * 1000000);
      this.pc = null;
      this.localStream = null;
      this.remoteStream = null;
      
      var self = this;
      
      // Send message to plugin
      this.send = function(sendOptions) {
        var message = sendOptions.message;
        
        // Simulate SIP plugin responses
        if (self.plugin === 'janus.plugin.sip') {
          setTimeout(function() {
            if (message.request === 'register') {
              // Simulate successful registration
              if (options.onmessage) {
                options.onmessage({ sip: 'registered' });
              }
            } else if (message.request === 'call') {
              // Simulate call progress
              if (options.onmessage) {
                options.onmessage({ sip: 'calling' });
                
                // Simulate call accepted after 2 seconds
                setTimeout(function() {
                  options.onmessage({ sip: 'accepted' });
                  
                  // Simulate remote audio track
                  if (options.onremotetrack) {
                    var audioTrack = new MediaStreamTrack();
                    audioTrack.kind = 'audio';
                    options.onremotetrack(audioTrack, 0, true);
                  }
                }, 2000);
              }
            } else if (message.request === 'hangup') {
              if (options.onmessage) {
                options.onmessage({ sip: 'hangup' });
              }
            }
          }, 500);
        }
      };
      
      // Create WebRTC offer
      this.createOffer = function(offerOptions) {
        // Get user media
        navigator.mediaDevices.getUserMedia({ audio: true, video: false })
          .then(function(stream) {
            self.localStream = stream;
            
            // Create RTCPeerConnection
            self.pc = new RTCPeerConnection({
              iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
            });
            
            // Add local stream
            stream.getTracks().forEach(function(track) {
              self.pc.addTrack(track, stream);
              if (options.onlocaltrack) {
                options.onlocaltrack(track, true);
              }
            });
            
            // Handle remote stream
            self.pc.ontrack = function(event) {
              if (options.onremotetrack && event.track) {
                options.onremotetrack(event.track, 0, true);
              }
            };
            
            // Create offer
            return self.pc.createOffer();
          })
          .then(function(offer) {
            return self.pc.setLocalDescription(offer);
          })
          .then(function() {
            if (offerOptions.success) {
              offerOptions.success({
                type: 'offer',
                sdp: self.pc.localDescription.sdp
              });
            }
          })
          .catch(function(error) {
            console.error('Create offer error:', error);
            if (offerOptions.error) {
              offerOptions.error(error);
            }
          });
      };
      
      // Handle remote JSEP
      this.handleRemoteJsep = function(options) {
        if (self.pc && options.jsep) {
          var desc = new RTCSessionDescription(options.jsep);
          self.pc.setRemoteDescription(desc).catch(console.error);
        }
      };
      
      // Hangup call
      this.hangup = function() {
        if (self.pc) {
          self.pc.close();
          self.pc = null;
        }
        if (self.localStream) {
          self.localStream.getTracks().forEach(function(track) {
            track.stop();
          });
          self.localStream = null;
        }
      };
      
      // Detach plugin
      this.detach = function() {
        self.hangup();
        if (options.detached) {
          options.detached();
        }
      };
      
      return this;
    }
  };

  // Make Janus constructor work with 'new' keyword
  window.Janus = function(options) {
    return new window.Janus.Session(options);
  };
  
  // Add static methods
  window.Janus.init = window.Janus.init;
  window.Janus.isWebrtcSupported = isWebrtcSupported;
  window.Janus.Session = window.Janus.Session;
  window.Janus.PluginHandle = window.Janus.PluginHandle;
  
})();