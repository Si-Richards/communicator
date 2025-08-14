// Audio quality optimization utilities
export interface AudioQualityMetrics {
  packetsLost: number
  packetsReceived: number
  jitter: number
  roundTripTime: number
  audioLevel: number
}

export class AudioQualityOptimizer {
  private audioContext: AudioContext | null = null
  private qualityMetrics: AudioQualityMetrics = {
    packetsLost: 0,
    packetsReceived: 0,
    jitter: 0,
    roundTripTime: 0,
    audioLevel: 0
  }

  constructor() {
    this.initializeAudioContext()
  }

  private initializeAudioContext() {
    try {
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({
        latencyHint: 'interactive',
        sampleRate: 48000
      })
    } catch (error) {
      console.warn('Could not create AudioContext:', error)
    }
  }

  // Optimize audio stream with real-time processing
  optimizeAudioStream(stream: MediaStream): MediaStream {
    if (!this.audioContext || !stream.getAudioTracks().length) {
      return stream
    }

    try {
      const audioTrack = stream.getAudioTracks()[0]
      const source = this.audioContext.createMediaStreamSource(stream)
      
      // Create audio processing chain
      const compressor = this.audioContext.createDynamicsCompressor()
      const gainNode = this.audioContext.createGain()
      
      // Configure compressor for voice optimization
      compressor.threshold.setValueAtTime(-24, this.audioContext.currentTime)
      compressor.knee.setValueAtTime(30, this.audioContext.currentTime)
      compressor.ratio.setValueAtTime(12, this.audioContext.currentTime)
      compressor.attack.setValueAtTime(0.003, this.audioContext.currentTime)
      compressor.release.setValueAtTime(0.25, this.audioContext.currentTime)
      
      // Set optimal gain
      gainNode.gain.setValueAtTime(1.2, this.audioContext.currentTime)
      
      // Connect processing chain
      source.connect(compressor)
      compressor.connect(gainNode)
      
      // Create destination for processed audio
      const destination = this.audioContext.createMediaStreamDestination()
      gainNode.connect(destination)
      
      return destination.stream
    } catch (error) {
      console.warn('Audio processing failed, using original stream:', error)
      return stream
    }
  }

  // Monitor call quality metrics
  async monitorCallQuality(peerConnection: RTCPeerConnection): Promise<AudioQualityMetrics> {
    try {
      const stats = await peerConnection.getStats()
      const audioStats = Array.from(stats.values()).find(stat => 
        stat.type === 'inbound-rtp' && stat.mediaType === 'audio'
      )

      if (audioStats) {
        this.qualityMetrics = {
          packetsLost: audioStats.packetsLost || 0,
          packetsReceived: audioStats.packetsReceived || 0,
          jitter: audioStats.jitter || 0,
          roundTripTime: audioStats.roundTripTime || 0,
          audioLevel: audioStats.audioLevel || 0
        }
      }

      return this.qualityMetrics
    } catch (error) {
      console.warn('Could not get call quality metrics:', error)
      return this.qualityMetrics
    }
  }

  // Get quality assessment
  getQualityAssessment(): 'excellent' | 'good' | 'fair' | 'poor' {
    const { packetsLost, packetsReceived, jitter } = this.qualityMetrics
    
    if (packetsReceived === 0) return 'poor'
    
    const lossPercentage = (packetsLost / (packetsLost + packetsReceived)) * 100
    
    if (lossPercentage < 1 && jitter < 20) return 'excellent'
    if (lossPercentage < 3 && jitter < 50) return 'good'
    if (lossPercentage < 5 && jitter < 100) return 'fair'
    return 'poor'
  }

  // Suggest quality improvements
  getQualityRecommendations(): string[] {
    const recommendations: string[] = []
    const { packetsLost, packetsReceived, jitter } = this.qualityMetrics
    
    if (packetsReceived === 0) {
      recommendations.push('Check network connection')
      return recommendations
    }
    
    const lossPercentage = (packetsLost / (packetsLost + packetsReceived)) * 100
    
    if (lossPercentage > 3) {
      recommendations.push('High packet loss detected - check network stability')
    }
    
    if (jitter > 50) {
      recommendations.push('High jitter detected - consider using wired connection')
    }
    
    if (recommendations.length === 0) {
      recommendations.push('Audio quality is optimal')
    }
    
    return recommendations
  }

  // Cleanup resources
  destroy() {
    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close()
    }
    this.audioContext = null
  }
}

// Enhanced audio constraints for different network conditions
export const getOptimalAudioConstraints = (networkQuality: 'high' | 'medium' | 'low' = 'high') => {
  const baseConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1
  }

  switch (networkQuality) {
    case 'high':
      return {
        ...baseConstraints,
        sampleRate: 48000,
        sampleSize: 16
      }
    case 'medium':
      return {
        ...baseConstraints,
        sampleRate: 32000,
        sampleSize: 16
      }
    case 'low':
      return {
        ...baseConstraints,
        sampleRate: 16000,
        sampleSize: 16
      }
    default:
      return baseConstraints
  }
}