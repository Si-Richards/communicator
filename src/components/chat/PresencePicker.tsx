/**
 * Presence picker component for setting user status
 */

import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { StatusIndicator } from '@/components/ui/status-indicator';
import { User, Check, X } from 'lucide-react';

interface PresencePickerProps {
  currentPresence: 'available' | 'away' | 'dnd' | 'xa' | 'unavailable';
  currentStatus?: string;
  onPresenceChange: (presence: 'available' | 'away' | 'dnd' | 'xa' | 'unavailable', status?: string) => void;
  disabled?: boolean;
}

export const PresencePicker: React.FC<PresencePickerProps> = ({
  currentPresence,
  currentStatus,
  onPresenceChange,
  disabled = false
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedPresence, setSelectedPresence] = useState(currentPresence);
  const [statusMessage, setStatusMessage] = useState(currentStatus || '');

  const presenceOptions = [
    { value: 'available', label: 'Available', variant: 'connected' as const },
    { value: 'away', label: 'Away', variant: 'connecting' as const },
    { value: 'dnd', label: 'Do Not Disturb', variant: 'error' as const },
    { value: 'xa', label: 'Extended Away', variant: 'disconnected' as const },
    { value: 'unavailable', label: 'Offline', variant: 'disconnected' as const }
  ];

  const currentOption = presenceOptions.find(opt => opt.value === currentPresence);

  const handleSave = () => {
    onPresenceChange(selectedPresence, statusMessage.trim() || undefined);
    setIsOpen(false);
  };

  const handleCancel = () => {
    setSelectedPresence(currentPresence);
    setStatusMessage(currentStatus || '');
    setIsOpen(false);
  };

  const handleOpenChange = (open: boolean) => {
    setIsOpen(open);
    if (open) {
      setSelectedPresence(currentPresence);
      setStatusMessage(currentStatus || '');
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          className="h-auto p-2 justify-start gap-2"
        >
          <StatusIndicator
            variant={currentOption?.variant || 'disconnected'}
            label={currentOption?.label || 'Offline'}
          />
          {currentStatus && (
            <span className="text-xs text-muted-foreground truncate max-w-24">
              {currentStatus}
            </span>
          )}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <User className="h-4 w-4" />
            Set Your Status
          </DialogTitle>
        </DialogHeader>
        
        <div className="space-y-4">
          {/* Presence Selection */}
          <div className="space-y-2">
            <Label>Presence</Label>
            <Select value={selectedPresence} onValueChange={(value: any) => setSelectedPresence(value)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {presenceOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    <div className="flex items-center gap-2">
                      <StatusIndicator variant={option.variant} label={option.label} />
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Status Message */}
          <div className="space-y-2">
            <Label>Status Message (Optional)</Label>
            <Input
              placeholder="What's on your mind?"
              value={statusMessage}
              onChange={(e) => setStatusMessage(e.target.value)}
              maxLength={100}
            />
            <p className="text-xs text-muted-foreground">
              {statusMessage.length}/100 characters
            </p>
          </div>

          {/* Action Buttons */}
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleCancel}
            >
              <X className="h-4 w-4 mr-1" />
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleSave}
            >
              <Check className="h-4 w-4 mr-1" />
              Save
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};