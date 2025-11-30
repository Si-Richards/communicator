import { useState, useMemo } from 'react';
import { useCallHistory } from '@/contexts/CallHistoryContext';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { LineChart, Line, BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { Activity, TrendingUp, Signal, AlertCircle } from 'lucide-react';
import { format, subDays, subHours, startOfDay, endOfDay } from 'date-fns';

const QUALITY_COLORS = {
  excellent: 'hsl(var(--call-success))',
  good: 'hsl(var(--primary))',
  fair: 'hsl(var(--call-warning))',
  poor: 'hsl(var(--call-danger))'
};

const CallQualityReport = () => {
  const { callHistory, getQualityStats, getCallsByDateRange } = useCallHistory();
  const [timeRange, setTimeRange] = useState<'24h' | '7d' | '30d' | 'all'>('7d');

  // Filter calls based on time range
  const filteredCalls = useMemo(() => {
    const now = new Date();
    let startDate: Date;

    switch (timeRange) {
      case '24h':
        startDate = subHours(now, 24);
        break;
      case '7d':
        startDate = subDays(now, 7);
        break;
      case '30d':
        startDate = subDays(now, 30);
        break;
      case 'all':
      default:
        return callHistory.filter(call => call.qualityMetrics);
    }

    return getCallsByDateRange(startDate, now).filter(call => call.qualityMetrics);
  }, [callHistory, timeRange, getCallsByDateRange]);

  // Calculate overall quality stats
  const qualityStats = useMemo(() => getQualityStats(), [getQualityStats]);

  // Prepare data for quality over time chart
  const qualityOverTimeData = useMemo(() => {
    const dataMap = new Map<string, { date: string; excellent: number; good: number; fair: number; poor: number }>();

    filteredCalls.forEach(call => {
      if (!call.qualityMetrics) return;
      
      const dateKey = format(call.timestamp, 'MMM dd');
      const existing = dataMap.get(dateKey) || { date: dateKey, excellent: 0, good: 0, fair: 0, poor: 0 };
      
      existing[call.qualityMetrics.quality]++;
      dataMap.set(dateKey, existing);
    });

    return Array.from(dataMap.values()).slice(-30); // Last 30 data points
  }, [filteredCalls]);

  // Prepare data for packet loss chart
  const packetLossData = useMemo(() => {
    return filteredCalls
      .filter(call => call.qualityMetrics)
      .slice(-20) // Last 20 calls
      .map((call, idx) => {
        const metrics = call.qualityMetrics!;
        const lossPercentage = metrics.packetsReceived > 0 
          ? (metrics.packetsLost / (metrics.packetsLost + metrics.packetsReceived)) * 100 
          : 0;
        
        return {
          call: `Call ${idx + 1}`,
          packetLoss: Number(lossPercentage.toFixed(2)),
          jitter: Number(metrics.jitter.toFixed(2)),
          time: format(call.timestamp, 'HH:mm')
        };
      });
  }, [filteredCalls]);

  // Prepare data for quality distribution pie chart
  const qualityDistributionData = useMemo(() => {
    return [
      { name: 'Excellent', value: qualityStats.qualityDistribution.excellent, color: QUALITY_COLORS.excellent },
      { name: 'Good', value: qualityStats.qualityDistribution.good, color: QUALITY_COLORS.good },
      { name: 'Fair', value: qualityStats.qualityDistribution.fair, color: QUALITY_COLORS.fair },
      { name: 'Poor', value: qualityStats.qualityDistribution.poor, color: QUALITY_COLORS.poor }
    ].filter(item => item.value > 0);
  }, [qualityStats]);

  // Get quality badge variant
  const getQualityBadgeVariant = (score: number) => {
    if (score >= 3.5) return 'default';
    if (score >= 2.5) return 'secondary';
    if (score >= 1.5) return 'outline';
    return 'destructive';
  };

  return (
    <div className="container mx-auto p-4 space-y-6 max-w-7xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Call Quality Report</h1>
          <p className="text-muted-foreground">Detailed analytics and metrics for your calls</p>
        </div>
        
        <Select value={timeRange} onValueChange={(value: any) => setTimeRange(value)}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="Select time range" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="24h">Last 24 Hours</SelectItem>
            <SelectItem value="7d">Last 7 Days</SelectItem>
            <SelectItem value="30d">Last 30 Days</SelectItem>
            <SelectItem value="all">All Time</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Average Quality</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {qualityStats.averageQuality.toFixed(1)}/4.0
            </div>
            <Badge variant={getQualityBadgeVariant(qualityStats.averageQuality)} className="mt-2">
              {qualityStats.averageQuality >= 3.5 ? 'Excellent' :
               qualityStats.averageQuality >= 2.5 ? 'Good' :
               qualityStats.averageQuality >= 1.5 ? 'Fair' : 'Poor'}
            </Badge>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Packet Loss</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {qualityStats.averagePacketLoss.toFixed(2)}%
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              {qualityStats.averagePacketLoss < 1 ? 'Excellent' : 
               qualityStats.averagePacketLoss < 3 ? 'Good' : 
               qualityStats.averagePacketLoss < 5 ? 'Fair' : 'Poor'}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Average Jitter</CardTitle>
            <Signal className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {qualityStats.averageJitter.toFixed(1)}ms
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              {qualityStats.averageJitter < 20 ? 'Excellent' : 
               qualityStats.averageJitter < 50 ? 'Good' : 
               qualityStats.averageJitter < 100 ? 'Fair' : 'Poor'}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Monitored Calls</CardTitle>
            <AlertCircle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {qualityStats.callsWithMetrics}
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              Calls with quality metrics
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Charts */}
      <Tabs defaultValue="trends" className="space-y-4">
        <TabsList>
          <TabsTrigger value="trends">Quality Trends</TabsTrigger>
          <TabsTrigger value="network">Network Metrics</TabsTrigger>
          <TabsTrigger value="distribution">Distribution</TabsTrigger>
        </TabsList>

        <TabsContent value="trends" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Call Quality Over Time</CardTitle>
              <CardDescription>
                Distribution of call quality ratings over the selected time period
              </CardDescription>
            </CardHeader>
            <CardContent>
              {qualityOverTimeData.length > 0 ? (
                <ResponsiveContainer width="100%" height={350}>
                  <BarChart data={qualityOverTimeData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis 
                      dataKey="date" 
                      stroke="hsl(var(--foreground))"
                      fontSize={12}
                    />
                    <YAxis 
                      stroke="hsl(var(--foreground))"
                      fontSize={12}
                    />
                    <Tooltip 
                      contentStyle={{ 
                        backgroundColor: 'hsl(var(--background))',
                        border: '1px solid hsl(var(--border))',
                        borderRadius: '6px'
                      }}
                    />
                    <Legend />
                    <Bar dataKey="excellent" stackId="a" fill={QUALITY_COLORS.excellent} name="Excellent" />
                    <Bar dataKey="good" stackId="a" fill={QUALITY_COLORS.good} name="Good" />
                    <Bar dataKey="fair" stackId="a" fill={QUALITY_COLORS.fair} name="Fair" />
                    <Bar dataKey="poor" stackId="a" fill={QUALITY_COLORS.poor} name="Poor" />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex items-center justify-center h-[350px] text-muted-foreground">
                  No quality data available for the selected time range
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="network" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Packet Loss & Jitter Analysis</CardTitle>
              <CardDescription>
                Recent call network performance metrics
              </CardDescription>
            </CardHeader>
            <CardContent>
              {packetLossData.length > 0 ? (
                <ResponsiveContainer width="100%" height={350}>
                  <LineChart data={packetLossData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis 
                      dataKey="call" 
                      stroke="hsl(var(--foreground))"
                      fontSize={12}
                    />
                    <YAxis 
                      yAxisId="left"
                      stroke="hsl(var(--foreground))"
                      fontSize={12}
                      label={{ value: 'Packet Loss (%)', angle: -90, position: 'insideLeft' }}
                    />
                    <YAxis 
                      yAxisId="right" 
                      orientation="right"
                      stroke="hsl(var(--foreground))"
                      fontSize={12}
                      label={{ value: 'Jitter (ms)', angle: 90, position: 'insideRight' }}
                    />
                    <Tooltip 
                      contentStyle={{ 
                        backgroundColor: 'hsl(var(--background))',
                        border: '1px solid hsl(var(--border))',
                        borderRadius: '6px'
                      }}
                    />
                    <Legend />
                    <Line 
                      yAxisId="left"
                      type="monotone" 
                      dataKey="packetLoss" 
                      stroke={QUALITY_COLORS.poor} 
                      name="Packet Loss (%)"
                      strokeWidth={2}
                    />
                    <Line 
                      yAxisId="right"
                      type="monotone" 
                      dataKey="jitter" 
                      stroke={QUALITY_COLORS.fair} 
                      name="Jitter (ms)"
                      strokeWidth={2}
                    />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex items-center justify-center h-[350px] text-muted-foreground">
                  No network metrics available for the selected time range
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="distribution" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Quality Distribution</CardTitle>
              <CardDescription>
                Breakdown of call quality ratings
              </CardDescription>
            </CardHeader>
            <CardContent>
              {qualityDistributionData.length > 0 ? (
                <ResponsiveContainer width="100%" height={350}>
                  <PieChart>
                    <Pie
                      data={qualityDistributionData}
                      cx="50%"
                      cy="50%"
                      labelLine={false}
                      label={({ name, percent }) => `${name}: ${(percent * 100).toFixed(0)}%`}
                      outerRadius={100}
                      fill="#8884d8"
                      dataKey="value"
                    >
                      {qualityDistributionData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip 
                      contentStyle={{ 
                        backgroundColor: 'hsl(var(--background))',
                        border: '1px solid hsl(var(--border))',
                        borderRadius: '6px'
                      }}
                    />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex items-center justify-center h-[350px] text-muted-foreground">
                  No quality distribution data available
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Recent Calls Table */}
      <Card>
        <CardHeader>
          <CardTitle>Recent Calls with Quality Metrics</CardTitle>
          <CardDescription>
            Detailed view of the most recent calls
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border text-left text-sm">
                  <th className="pb-3 font-medium">Time</th>
                  <th className="pb-3 font-medium">Number</th>
                  <th className="pb-3 font-medium">Duration</th>
                  <th className="pb-3 font-medium">Quality</th>
                  <th className="pb-3 font-medium">Packet Loss</th>
                  <th className="pb-3 font-medium">Jitter</th>
                </tr>
              </thead>
              <tbody>
                {filteredCalls.slice(0, 10).map(call => {
                  if (!call.qualityMetrics) return null;
                  const lossPercentage = call.qualityMetrics.packetsReceived > 0
                    ? (call.qualityMetrics.packetsLost / (call.qualityMetrics.packetsLost + call.qualityMetrics.packetsReceived)) * 100
                    : 0;

                  return (
                    <tr key={call.id} className="border-b border-border text-sm">
                      <td className="py-3">{format(call.timestamp, 'MMM dd, HH:mm')}</td>
                      <td className="py-3">{call.contactName || call.phoneNumber}</td>
                      <td className="py-3">{Math.floor(call.duration / 60)}m {call.duration % 60}s</td>
                      <td className="py-3">
                        <Badge variant={
                          call.qualityMetrics.quality === 'excellent' ? 'default' :
                          call.qualityMetrics.quality === 'good' ? 'secondary' :
                          call.qualityMetrics.quality === 'fair' ? 'outline' : 'destructive'
                        }>
                          {call.qualityMetrics.quality}
                        </Badge>
                      </td>
                      <td className="py-3">{lossPercentage.toFixed(2)}%</td>
                      <td className="py-3">{call.qualityMetrics.jitter.toFixed(1)}ms</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {filteredCalls.length === 0 && (
            <div className="text-center py-8 text-muted-foreground">
              No calls with quality metrics found for the selected time range
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default CallQualityReport;
