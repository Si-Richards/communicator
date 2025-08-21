/**
 * Tenor GIF API integration for chat GIF support
 * Using Tenor's public API with basic search functionality
 */

export interface TenorGif {
  id: string;
  title: string;
  url: string;
  preview: string;
  dimensions: {
    width: number;
    height: number;
  };
}

const TENOR_API_KEY = 'YOUR_API_KEY'; // In production, this would be from environment
const TENOR_BASE_URL = 'https://tenor.googleapis.com/v2';

/**
 * Mock Tenor API for development - returns sample GIFs
 * In production, this would make real API calls to Tenor
 */
export const searchGifs = async (query: string, limit: number = 20): Promise<TenorGif[]> => {
  // Mock data for development - replace with real API call
  const mockGifs: TenorGif[] = [
    {
      id: '1',
      title: `${query} reaction 1`,
      url: 'https://media.tenor.com/mock1.gif', 
      preview: 'https://media.tenor.com/mock1-preview.jpg',
      dimensions: { width: 400, height: 300 }
    },
    {
      id: '2', 
      title: `${query} reaction 2`,
      url: 'https://media.tenor.com/mock2.gif',
      preview: 'https://media.tenor.com/mock2-preview.jpg', 
      dimensions: { width: 300, height: 400 }
    },
    {
      id: '3',
      title: `${query} reaction 3`, 
      url: 'https://media.tenor.com/mock3.gif',
      preview: 'https://media.tenor.com/mock3-preview.jpg',
      dimensions: { width: 350, height: 350 }
    }
  ];

  // Simulate API delay
  await new Promise(resolve => setTimeout(resolve, 500));
  
  return mockGifs.filter(gif => 
    gif.title.toLowerCase().includes(query.toLowerCase())
  );
};

/**
 * Get trending GIFs
 */
export const getTrendingGifs = async (limit: number = 20): Promise<TenorGif[]> => {
  // Mock trending GIFs
  return searchGifs('trending', limit);
};

/**
 * Real Tenor API implementation (commented out for demo)
 */
/*
export const searchGifs = async (query: string, limit: number = 20): Promise<TenorGif[]> => {
  try {
    const response = await fetch(
      `${TENOR_BASE_URL}/search?q=${encodeURIComponent(query)}&key=${TENOR_API_KEY}&limit=${limit}&media_filter=gif`
    );
    
    if (!response.ok) {
      throw new Error('Failed to fetch GIFs');
    }
    
    const data = await response.json();
    
    return data.results.map((item: any) => ({
      id: item.id,
      title: item.content_description,
      url: item.media_formats.gif.url,
      preview: item.media_formats.tinygif.url,
      dimensions: {
        width: item.media_formats.gif.dims[0],
        height: item.media_formats.gif.dims[1]
      }
    }));
  } catch (error) {
    console.error('Error fetching GIFs:', error);
    return [];
  }
};
*/