import { useState } from 'react'
import { ArrowRight, Phone, PhoneOff, Loader2 } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useJanusContext } from '@/contexts/JanusContext'
import { toast } from '@/hooks/use-toast'

interface TransferDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export const TransferDialog = ({ open, onOpenChange }: TransferDialogProps) => {
  const { callState, transferBlind, startAttendedTransfer, completeAttendedTransfer, cancelAttendedTransfer } = useJanusContext()
  const [destination, setDestination] = useState('')
  const [transferring, setTransferring] = useState(false)

  const handleBlindTransfer = async () => {
    if (!destination.trim()) {
      toast({
        title: "Invalid Destination",
        description: "Please enter a phone number",
        variant: "destructive"
      })
      return
    }

    setTransferring(true)
    try {
      await transferBlind(destination.trim())
      onOpenChange(false)
      setDestination('')
    } catch (error) {
      console.error('Blind transfer failed:', error)
    } finally {
      setTransferring(false)
    }
  }

  const handleStartAttendedTransfer = async () => {
    if (!destination.trim()) {
      toast({
        title: "Invalid Destination", 
        description: "Please enter a phone number",
        variant: "destructive"
      })
      return
    }

    setTransferring(true)
    try {
      await startAttendedTransfer(destination.trim())
    } catch (error) {
      console.error('Attended transfer failed:', error)
    } finally {
      setTransferring(false)
    }
  }

  const handleCompleteAttendedTransfer = async () => {
    setTransferring(true)
    try {
      await completeAttendedTransfer()
      onOpenChange(false)
      setDestination('')
    } catch (error) {
      console.error('Complete transfer failed:', error)
    } finally {
      setTransferring(false)
    }
  }

  const handleCancelAttendedTransfer = () => {
    cancelAttendedTransfer()
    onOpenChange(false)
    setDestination('')
  }

  const isInCall = callState.status === 'incall'
  const hasConsultCall = !!callState.consultCall
  const consultConnected = callState.consultCall?.status === 'connected'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px] bg-background border shadow-lg z-[100]">
        <DialogHeader>
          <DialogTitle>Transfer Call</DialogTitle>
        </DialogHeader>
        
        <div className="space-y-4">
          {!hasConsultCall ? (
            <Tabs defaultValue="blind" className="w-full">
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="blind">Blind Transfer</TabsTrigger>
                <TabsTrigger value="attended">Attended Transfer</TabsTrigger>
              </TabsList>
              
              <TabsContent value="blind" className="space-y-4 mt-4">
                <div className="space-y-2">
                  <label htmlFor="blind-destination" className="text-sm font-medium">
                    Transfer to:
                  </label>
                  <Input
                    id="blind-destination"
                    type="tel"
                    placeholder="Enter phone number"
                    value={destination}
                    onChange={(e) => setDestination(e.target.value)}
                    disabled={transferring || !isInCall}
                  />
                </div>
                <div className="flex justify-end space-x-2">
                  <Button
                    variant="outline"
                    onClick={() => onOpenChange(false)}
                    disabled={transferring}
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={handleBlindTransfer}
                    disabled={transferring || !isInCall || !destination.trim()}
                    className="min-w-[100px]"
                  >
                    {transferring ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <>
                        <ArrowRight className="h-4 w-4 mr-2" />
                        Transfer
                      </>
                    )}
                  </Button>
                </div>
              </TabsContent>
              
              <TabsContent value="attended" className="space-y-4 mt-4">
                <div className="space-y-2">
                  <label htmlFor="attended-destination" className="text-sm font-medium">
                    Consult with:
                  </label>
                  <Input
                    id="attended-destination"
                    type="tel"
                    placeholder="Enter phone number"
                    value={destination}
                    onChange={(e) => setDestination(e.target.value)}
                    disabled={transferring || !isInCall}
                  />
                </div>
                <div className="flex justify-end space-x-2">
                  <Button
                    variant="outline"
                    onClick={() => onOpenChange(false)}
                    disabled={transferring}
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={handleStartAttendedTransfer}
                    disabled={transferring || !isInCall || !destination.trim()}
                    className="min-w-[120px]"
                  >
                    {transferring ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <>
                        <Phone className="h-4 w-4 mr-2" />
                        Start Consult
                      </>
                    )}
                  </Button>
                </div>
              </TabsContent>
            </Tabs>
          ) : (
            <div className="space-y-4">
              <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
                <h3 className="font-medium text-blue-900 dark:text-blue-100">
                  Consultation Call
                </h3>
                <p className="text-sm text-blue-700 dark:text-blue-300 mt-1">
                  {callState.consultCall.status === 'calling' 
                    ? `Calling ${callState.consultCall.phoneNumber}...`
                    : `Connected to ${callState.consultCall.phoneNumber}`
                  }
                </p>
              </div>
              
              <div className="flex justify-end space-x-2">
                <Button
                  variant="outline"
                  onClick={handleCancelAttendedTransfer}
                  disabled={transferring}
                  className="text-red-600 hover:text-red-700"
                >
                  <PhoneOff className="h-4 w-4 mr-2" />
                  Cancel Consult
                </Button>
                <Button
                  onClick={handleCompleteAttendedTransfer}
                  disabled={transferring || !consultConnected}
                  className="min-w-[120px]"
                >
                  {transferring ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <>
                      <ArrowRight className="h-4 w-4 mr-2" />
                      Complete Transfer
                    </>
                  )}
                </Button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}