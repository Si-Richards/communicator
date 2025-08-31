/**
 * GIF picker component for chat message composition
 */

import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Image, Search, Loader2 } from 'lucide-react';
import { searchGifs, getTrendingGifs, TenorGif } from '@/lib/tenorApi';

interface GifPickerProps {
  onGifSelect: (gifUrl: string) => void;
  disabled?: boolean;
}

export const GifPicker: React.FC<GifPickerProps> = ({ 
  onGifSelect, 
  disabled = false 
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [gifs, setGifs] = useState<TenorGif[]>([]);
  const [loading, setLoading] = useState(false);

  // Load trending GIFs on open
  useEffect(() => {
    if (isOpen && gifs.length === 0) {
      loadTrending();
    }
  }, [isOpen]);

  // Search GIFs when search term changes
  useEffect(() => {
    if (searchTerm.trim()) {
      const timeoutId = setTimeout(() => {
        searchForGifs(searchTerm);
      }, 500); // Debounce search
      
      return () => clearTimeout(timeoutId);
    } else if (isOpen) {
      loadTrending();
    }
  }, [searchTerm]);

  const loadTrending = async () => {
    setLoading(true);
    try {
      const trendingGifs = await getTrendingGifs(20);
      setGifs(trendingGifs);
    } catch (error) {
      console.error('Failed to load trending GIFs:', error);
    } finally {
      setLoading(false);
    }
  };

  const searchForGifs = async (query: string) => {
    setLoading(true);
    try {
      const searchResults = await searchGifs(query, 20);
      setGifs(searchResults);
    } catch (error) {
      console.error('Failed to search GIFs:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleGifSelect = (gif: TenorGif) => {
    onGifSelect(gif.url);
    setIsOpen(false);
    setSearchTerm('');
  };

  const handleOpenChange = (open: boolean) => {
    setIsOpen(open);
    if (!open) {
      setSearchTerm('');
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          className="h-8 w-8 p-0 hover:bg-muted"
        >
          <Image className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md max-h-[600px]">
        <DialogHeader>
          <DialogTitle>Choose a GIF</DialogTitle>
        </DialogHeader>
        
        <div className="space-y-4">
          {/* Search Input */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search GIFs..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10"
            />
          </div>

          {/* GIF Grid */}
          <ScrollArea className="h-80">
            {loading ? (
              <div className="flex items-center justify-center h-40">
                <Loader2 className="h-6 w-6 animate-spin" />
                <span className="ml-2 text-sm text-muted-foreground">Loading GIFs...</span>
              </div>
            ) : gifs.length === 0 ? (
              <div className="flex items-center justify-center h-40 text-muted-foreground">
                <div className="text-center">
                  <Image className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  <p className="text-sm">
                    {searchTerm ? 'No GIFs found' : 'No trending GIFs available'}
                  </p>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2 p-1">
                {gifs.map((gif) => (
                  <div
                    key={gif.id}
                    onClick={() => handleGifSelect(gif)}
                    className="cursor-pointer rounded-md overflow-hidden hover:opacity-80 transition-opacity"
                  >
                    <img
                      src={gif.preview}
                      alt={gif.title}
                      className="w-full h-24 object-cover"
                      loading="lazy"
                    />
                  </div>
                ))}
              </div>
            )}
          </ScrollArea>
          
          {/* Footer */}
          <div className="text-xs text-muted-foreground text-center">
            Powered by Tenor
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};