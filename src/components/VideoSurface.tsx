import { useRef, useEffect } from 'react'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'

interface VideoSurfaceProps {
  stream?: MediaStream
  isLocal?: boolean
  isMirrored?: boolean
  className?: string
  placeholder?: string
}

export const VideoSurface = ({ 
  stream, 
  isLocal = false, 
  isMirrored = false, 
  className,
  placeholder = "No video"
}: VideoSurfaceProps) => {
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream
      videoRef.current.play().catch(console.error)
    } else if (videoRef.current) {
      videoRef.current.srcObject = null
    }
  }, [stream])

  return (
    <Card className={cn(
      "relative overflow-hidden bg-muted/20 flex items-center justify-center",
      className
    )}>
      {stream ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={isLocal}
          className={cn(
            "w-full h-full object-cover",
            isMirrored && "scale-x-[-1]"
          )}
        />
      ) : (
        <div className="text-muted-foreground text-sm">
          {placeholder}
        </div>
      )}
    </Card>
  )
}