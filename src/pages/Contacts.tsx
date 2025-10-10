import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { useContacts, Contact } from '@/contexts/ContactsContext';
import { useJanusContext } from '@/contexts/JanusContext';
import { Search, Plus, Phone, Edit, Trash2, Download, Upload, MessageSquare } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { ImportXmppContactsDialog } from '@/components/ImportXmppContactsDialog';

const Contacts = () => {
  const { contacts, addContact, updateContact, deleteContact, searchContacts, exportContacts, importContacts, clearContacts, addPhoneNumber, removePhoneNumber } = useContacts();
  const { makeCall } = useJanusContext();
  const { toast } = useToast();
  
  const [searchQuery, setSearchQuery] = useState('');
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [editingContact, setEditingContact] = useState<Contact | null>(null);
  const [showImportXmppDialog, setShowImportXmppDialog] = useState(false);
  const [formData, setFormData] = useState({
    name: '',
    phoneNumbers: [''],
    email: '',
    xmppJid: '',
    notes: ''
  });

  const filteredContacts = searchQuery ? searchContacts(searchQuery) : contacts;

  const resetForm = () => {
    setFormData({ name: '', phoneNumbers: [''], email: '', xmppJid: '', notes: '' });
    setEditingContact(null);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    const validPhoneNumbers = formData.phoneNumbers.filter(phone => phone.trim());
    if (!formData.name.trim() || validPhoneNumbers.length === 0) {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Name and at least one phone number are required.",
      });
      return;
    }

    if (editingContact) {
      updateContact(editingContact.id, {
        name: formData.name,
        phoneNumbers: validPhoneNumbers,
        email: formData.email || undefined,
        xmppJid: formData.xmppJid || undefined,
        notes: formData.notes || undefined,
      });
      toast({
        title: "Contact updated",
        description: `${formData.name} has been updated.`,
      });
    } else {
      addContact({
        name: formData.name,
        phoneNumbers: validPhoneNumbers,
        email: formData.email || undefined,
        xmppJid: formData.xmppJid || undefined,
        notes: formData.notes || undefined,
      });
      toast({
        title: "Contact added",
        description: `${formData.name} has been added to your contacts.`,
      });
    }

    resetForm();
    setIsAddDialogOpen(false);
  };

  const handleEdit = (contact: Contact) => {
    setEditingContact(contact);
    setFormData({
      name: contact.name,
      phoneNumbers: contact.phoneNumbers.length > 0 ? contact.phoneNumbers : [''],
      email: contact.email || '',
      xmppJid: contact.xmppJid || '',
      notes: contact.notes || ''
    });
    setIsAddDialogOpen(true);
  };

  const handleDelete = (contact: Contact) => {
    deleteContact(contact.id);
    toast({
      title: "Contact deleted",
      description: `${contact.name} has been removed from your contacts.`,
    });
  };

  const handleCall = (phoneNumber: string) => {
    makeCall(phoneNumber);
  };

  const handleStartChat = (xmppJid: string) => {
    window.location.href = `/chat?jid=${encodeURIComponent(xmppJid)}`;
  };

  const handleExport = () => {
    const data = exportContacts();
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `contacts-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    toast({
      title: "Contacts exported",
      description: "Your contacts have been downloaded as a JSON file.",
    });
  };

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const data = event.target?.result as string;
      if (importContacts(data)) {
        toast({
          title: "Contacts imported",
          description: "Your contacts have been successfully imported.",
        });
      } else {
        toast({
          variant: "destructive",
          title: "Import failed",
          description: "Failed to import contacts. Please check the file format.",
        });
      }
    };
    reader.readAsText(file);
    e.target.value = ''; // Reset input
  };

  const handleClearAll = () => {
    clearContacts();
    toast({
      title: "All contacts cleared",
      description: "All contacts have been removed.",
    });
  };

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <h1 className="text-3xl font-bold">Contacts</h1>
        <div className="flex flex-wrap gap-2">
          <Button onClick={handleExport} variant="outline" size="sm">
            <Download className="w-4 h-4 mr-2" />
            Export
          </Button>
          <label className="cursor-pointer">
            <input
              type="file"
              accept=".json"
              onChange={handleImport}
              className="hidden"
            />
            <Button variant="outline" size="sm" asChild>
              <span>
                <Upload className="w-4 h-4 mr-2" />
                Import
              </span>
            </Button>
          </label>
          <Button 
            variant="outline" 
            size="sm"
            onClick={() => setShowImportXmppDialog(true)}
          >
            <MessageSquare className="w-4 h-4 mr-2" />
            Import from Chat
          </Button>
          <Dialog open={isAddDialogOpen} onOpenChange={(open) => {
            setIsAddDialogOpen(open);
            if (!open) resetForm();
          }}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="w-4 h-4 mr-2" />
                Add Contact
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{editingContact ? 'Edit Contact' : 'Add New Contact'}</DialogTitle>
              </DialogHeader>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <Label htmlFor="name">Name *</Label>
                  <Input
                    id="name"
                    value={formData.name}
                    onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                    placeholder="Enter contact name"
                    required
                  />
                </div>
                <div>
                  <Label>Phone Numbers *</Label>
                  {formData.phoneNumbers.map((phone, index) => (
                    <div key={index} className="flex gap-2 mt-2">
                      <Input
                        value={phone}
                        onChange={(e) => {
                          const newPhoneNumbers = [...formData.phoneNumbers];
                          newPhoneNumbers[index] = e.target.value;
                          setFormData(prev => ({ ...prev, phoneNumbers: newPhoneNumbers }));
                        }}
                        placeholder="Enter phone number"
                      />
                      {formData.phoneNumbers.length > 1 && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            const newPhoneNumbers = formData.phoneNumbers.filter((_, i) => i !== index);
                            setFormData(prev => ({ ...prev, phoneNumbers: newPhoneNumbers }));
                          }}
                        >
                          Remove
                        </Button>
                      )}
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="mt-2"
                    onClick={() => {
                      setFormData(prev => ({ ...prev, phoneNumbers: [...prev.phoneNumbers, ''] }));
                    }}
                  >
                    <Plus className="w-4 h-4 mr-2" />
                    Add Phone Number
                  </Button>
                </div>
                <div>
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    value={formData.email}
                    onChange={(e) => setFormData(prev => ({ ...prev, email: e.target.value }))}
                    placeholder="Enter email address"
                  />
                </div>
                <div>
                  <Label htmlFor="xmppJid">XMPP/Jabber ID (for chat)</Label>
                  <Input
                    id="xmppJid"
                    type="text"
                    value={formData.xmppJid}
                    onChange={(e) => setFormData(prev => ({ ...prev, xmppJid: e.target.value }))}
                    placeholder="e.g., user@ejabberd.voicehost.io"
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    Optional: Add XMPP address to enable chat with this contact
                  </p>
                </div>
                <div>
                  <Label htmlFor="notes">Notes</Label>
                  <Textarea
                    id="notes"
                    value={formData.notes}
                    onChange={(e) => setFormData(prev => ({ ...prev, notes: e.target.value }))}
                    placeholder="Additional notes"
                    rows={3}
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="outline" onClick={() => setIsAddDialogOpen(false)}>
                    Cancel
                  </Button>
                  <Button type="submit">
                    {editingContact ? 'Update' : 'Add'} Contact
                  </Button>
                </div>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-col sm:flex-row gap-4">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground w-4 h-4" />
              <Input
                placeholder="Search contacts..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10"
              />
            </div>
            {contacts.length > 0 && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="destructive" size="sm">
                    Clear All
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Clear all contacts?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This action cannot be undone. All your contacts will be permanently deleted.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={handleClearAll}>
                      Clear All
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {filteredContacts.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              {contacts.length === 0 ? "No contacts yet. Add your first contact!" : "No contacts match your search."}
            </div>
          ) : (
            <div className="space-y-2">
              {filteredContacts.map((contact) => (
                <div
                  key={contact.id}
                  className="flex items-center justify-between p-4 border rounded-lg hover:bg-muted/50 transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold truncate">{contact.name}</h3>
                    <div className="space-y-1">
                      {contact.phoneNumbers.map((phone, index) => (
                        <div key={index} className="flex items-center gap-2">
                          <p className="text-sm text-muted-foreground">{phone}</p>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => handleCall(phone)}
                            className="h-6 w-6 p-0 shrink-0"
                          >
                            <Phone className="w-3 h-3" />
                          </Button>
                        </div>
                      ))}
                    </div>
                    {contact.email && (
                      <p className="text-sm text-muted-foreground">{contact.email}</p>
                    )}
                    {contact.xmppJid && (
                      <p className="text-sm text-muted-foreground flex items-center gap-1">
                        <MessageSquare className="w-3 h-3" />
                        {contact.xmppJid}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {contact.xmppJid && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => handleStartChat(contact.xmppJid!)}
                        title="Start chat"
                        className="shrink-0"
                      >
                        <MessageSquare className="w-4 h-4" />
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleEdit(contact)}
                      className="shrink-0"
                    >
                      <Edit className="w-4 h-4" />
                    </Button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button size="sm" variant="outline" className="shrink-0">
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete contact?</AlertDialogTitle>
                          <AlertDialogDescription>
                            Are you sure you want to delete {contact.name}? This action cannot be undone.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction onClick={() => handleDelete(contact)}>
                            Delete
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
      <ImportXmppContactsDialog 
        open={showImportXmppDialog}
        onOpenChange={setShowImportXmppDialog}
      />
    </div>
  );
};

export default Contacts;