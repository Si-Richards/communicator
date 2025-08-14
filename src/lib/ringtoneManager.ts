class RingtoneManager {
  private incomingAudio: HTMLAudioElement | null = null
  private outgoingAudio: HTMLAudioElement | null = null
  private isPlaying = false
  private volume = 0.5

  constructor() {
    this.preloadAudio()
  }

  private preloadAudio() {
    try {
      this.incomingAudio = new Audio('/audio/incoming-ring.mp3')
      this.outgoingAudio = new Audio('/audio/outgoing-ring.mp3')
      
      // Set default properties
      if (this.incomingAudio) {
        this.incomingAudio.loop = true
        this.incomingAudio.volume = this.volume
        this.incomingAudio.preload = 'auto'
      }
      
      if (this.outgoingAudio) {
        this.outgoingAudio.loop = true
        this.outgoingAudio.volume = this.volume
        this.outgoingAudio.preload = 'auto'
      }
    } catch (error) {
      console.warn('Failed to preload ringtone audio files:', error)
    }
  }

  async playIncomingRing(): Promise<void> {
    if (!this.incomingAudio || this.isPlaying) return

    try {
      this.stopRinging() // Stop any currently playing rings
      this.isPlaying = true
      await this.incomingAudio.play()
      console.log('Playing incoming ringtone')
    } catch (error) {
      console.warn('Failed to play incoming ringtone:', error)
      this.isPlaying = false
    }
  }

  async playOutgoingRing(): Promise<void> {
    if (!this.outgoingAudio || this.isPlaying) return

    try {
      this.stopRinging() // Stop any currently playing rings
      this.isPlaying = true
      await this.outgoingAudio.play()
      console.log('Playing outgoing ringtone')
    } catch (error) {
      console.warn('Failed to play outgoing ringtone:', error)
      this.isPlaying = false
    }
  }

  stopRinging(): void {
    this.isPlaying = false
    
    if (this.incomingAudio) {
      this.incomingAudio.pause()
      this.incomingAudio.currentTime = 0
    }
    
    if (this.outgoingAudio) {
      this.outgoingAudio.pause()
      this.outgoingAudio.currentTime = 0
    }
    
    console.log('Stopped all ringtones')
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume))
    
    if (this.incomingAudio) {
      this.incomingAudio.volume = this.volume
    }
    
    if (this.outgoingAudio) {
      this.outgoingAudio.volume = this.volume
    }
  }

  getVolume(): number {
    return this.volume
  }

  destroy(): void {
    this.stopRinging()
    this.incomingAudio = null
    this.outgoingAudio = null
  }
}

// Create singleton instance
export const ringtoneManager = new RingtoneManager()
export default ringtoneManager