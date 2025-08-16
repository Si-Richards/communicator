import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/AppSidebar";
import { useJanusContext } from "@/contexts/JanusContext";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
export default function Layout({
  children
}: {
  children: React.ReactNode;
}) {
  const { callState, reconnect } = useJanusContext();

  const getConnectionStatus = () => {
    if (callState.registered) {
      return { text: 'Connected', color: 'text-green-600' }
    }
    return { text: 'Disconnected', color: 'text-red-500' }
  }

  const connectionStatus = getConnectionStatus();

  return <SidebarProvider>
      <div className="min-h-screen flex w-full bg-background">
        <AppSidebar />
        
        <div className="flex-1 flex flex-col">
          {/* Header with toggle and status */}
          <header className="h-12 flex items-center justify-between border-b border-border bg-card px-4">
            <div className="flex items-center">
              <SidebarTrigger className="text-muted-foreground hover:text-foreground" />
              <div className="ml-4 text-sm font-medium text-foreground">VoiceHost Limited</div>
            </div>
            
            {/* Connection Status */}
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2 text-sm">
                <div className={`w-2 h-2 rounded-full ${callState.registered ? 'bg-green-500' : 'bg-red-500'}`} />
                <span className={`font-medium ${connectionStatus.color}`}>
                  {connectionStatus.text}
                </span>
              </div>
              
              {/* Reconnect Button */}
              {!callState.registered && (
                <Button 
                  onClick={reconnect} 
                  size="sm" 
                  variant="outline" 
                  className="text-xs"
                >
                  <RefreshCw className="h-3 w-3 mr-1" />
                  Reconnect
                </Button>
              )}
            </div>
          </header>

          {/* Main content */}
          <main className="flex-1 overflow-auto">
            {children}
          </main>
        </div>
      </div>
    </SidebarProvider>;
}