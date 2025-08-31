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
// Real Tenor API implementation
export const searchGifs = async (query: string, limit: number = 20): Promise<TenorGif[]> => {
  try {
    const apiKey = import.meta.env.VITE_TENOR_API_KEY || 'AIzaSyAyimkuYQYF_FXVALexPuGQctUWRURdCYQ'; // Demo key
    const response = await fetch(
      `https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(query)}&key=${apiKey}&limit=${limit}&media_filter=gif,tinygif&contentfilter=medium`
    );
    
    if (!response.ok) {
      throw new Error(`Tenor API error: ${response.status}`);
    }
    
    const data = await response.json();
    
    return data.results?.map((item: any) => ({
      id: item.id,
      title: item.content_description || query,
      url: item.media_formats?.gif?.url || item.media_formats?.tinygif?.url,
      preview: item.media_formats?.tinygif?.url || item.media_formats?.gif?.url,
      dimensions: {
        width: item.media_formats?.gif?.dims?.[0] || 220,
        height: item.media_formats?.gif?.dims?.[1] || 220
      }
    })) || [];
  } catch (error) {
    console.error('Failed to search GIFs:', error);
    // Fallback to empty array instead of mock data
    return [];
  }
};

/**
 * Get trending GIFs from Tenor API 
 */
export const getTrendingGifs = async (limit: number = 20): Promise<TenorGif[]> => {
  try {
    const apiKey = import.meta.env.VITE_TENOR_API_KEY || 'AIzaSyAyimkuYQYF_FXVALexPuGQctUWRURdCYQ'; // Demo key
    const response = await fetch(
      `https://tenor.googleapis.com/v2/featured?key=${apiKey}&limit=${limit}&media_filter=gif,tinygif&contentfilter=medium`
    );
    
    if (!response.ok) {
      throw new Error(`Tenor API error: ${response.status}`);
    }
    
    const data = await response.json();
    
    return data.results?.map((item: any) => ({
      id: item.id,
      title: item.content_description || 'Trending GIF',
      url: item.media_formats?.gif?.url || item.media_formats?.tinygif?.url,
      preview: item.media_formats?.tinygif?.url || item.media_formats?.gif?.url,
      dimensions: {
        width: item.media_formats?.gif?.dims?.[0] || 220,
        height: item.media_formats?.gif?.dims?.[1] || 220
      }
    })) || [];
  } catch (error) {
    console.error('Failed to get trending GIFs:', error);
    return [];
  }
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