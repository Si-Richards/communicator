import { useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { useJanusContext } from '@/contexts/JanusContext'
import { toast } from '@/hooks/use-toast'

interface TransferDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export const TransferDialog = ({ open, onOpenChange }: TransferDialogProps) => {
  const [targetNumber, setTargetNumber] = useState('')
  const [transferType, setTransferType] = useState<'blind' | 'attended'>('blind')
  const [isTransferring, setIsTransferring] = useState(false)
  const { blindTransfer, attendedTransfer } = useJanusContext()

  const handleTransfer = async () => {
    if (!targetNumber.trim()) {
      toast({
        title: "Invalid Number",
        description: "Please enter a phone number to transfer to",
        variant: "destructive"
      })
      return
    }

    setIsTransferring(true)
    
    try {
      if (transferType === 'blind') {
        await blindTransfer(targetNumber.trim())
      } else {
        await attendedTransfer(targetNumber.trim())
      }
      
      // Close dialog after successful transfer
      onOpenChange(false)
      setTargetNumber('')
    } catch (error) {
      console.error('Transfer failed:', error)
    } finally {
      setIsTransferring(false)
    }
  }

  const handleCancel = () => {
    setTargetNumber('')
    setTransferType('blind')
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Transfer Call</DialogTitle>
        </DialogHeader>
        
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="target-number">Phone Number</Label>
            <Input
              id="target-number"
              type="tel"
              value={targetNumber}
              onChange={(e) => setTargetNumber(e.target.value)}
              placeholder="Enter phone number"
              className="text-center"
            />
          </div>

          <div className="space-y-3">
            <Label>Transfer Type</Label>
            <RadioGroup
              value={transferType}
              onValueChange={(value) => setTransferType(value as 'blind' | 'attended')}
              className="space-y-2"
            >
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="blind" id="blind" />
                <Label htmlFor="blind" className="text-sm">
                  Blind Transfer (immediate)
                </Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="attended" id="attended" />
                <Label htmlFor="attended" className="text-sm">
                  Attended Transfer (with consultation)
                </Label>
              </div>
            </RadioGroup>
          </div>
        </div>

        <DialogFooter className="flex gap-2">
          <Button
            variant="outline"
            onClick={handleCancel}
            disabled={isTransferring}
          >
            Cancel
          </Button>
          <Button
            onClick={handleTransfer}
            disabled={!targetNumber.trim() || isTransferring}
          >
            {isTransferring ? 'Transferring...' : 'Transfer Call'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}