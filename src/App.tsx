import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { JanusProvider } from "./contexts/JanusContext";
import { SettingsProvider } from "./contexts/SettingsContext";
import { ContactsProvider } from "./contexts/ContactsContext";
import { CallHistoryProvider } from "./contexts/CallHistoryContext";
import { NotificationBootstrap } from "./components/NotificationBootstrap";
import { XmppProvider } from "./contexts/XmppContext";
import Layout from "./components/Layout";
import Dial from "./pages/Dial";
import Contacts from "./pages/Contacts";
import History from "./pages/History";
import Voicemail from "./pages/Voicemail";
import Chat from "./pages/Chat";
import SMS from "./pages/SMS";
import SettingsPage from "./pages/SettingsPage";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <SettingsProvider>
      <NotificationBootstrap>
        <ContactsProvider>
          <CallHistoryProvider>
            <TooltipProvider>
              <Toaster />
              <Sonner />
              <JanusProvider>
                <XmppProvider>
                  <BrowserRouter>
                    <Layout>
                      <Routes>
                        <Route path="/" element={<Dial />} />
                        <Route path="/contacts" element={<Contacts />} />
                        <Route path="/history" element={<History />} />
                        <Route path="/voicemail" element={<Voicemail />} />
                        <Route path="/messages" element={<Chat />} />
                        <Route path="/chat" element={<Navigate to="/messages" replace />} />
                        <Route path="/rooms" element={<Navigate to="/messages?tab=rooms" replace />} />
                        <Route path="/sms" element={<SMS />} />
                        <Route path="/settings" element={<SettingsPage />} />
                        {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
                        <Route path="*" element={<NotFound />} />
                      </Routes>
                    </Layout>
                  </BrowserRouter>
                </XmppProvider>
              </JanusProvider>
            </TooltipProvider>
          </CallHistoryProvider>
        </ContactsProvider>
      </NotificationBootstrap>
    </SettingsProvider>
  </QueryClientProvider>
);

export default App;