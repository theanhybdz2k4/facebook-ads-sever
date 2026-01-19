
import { PrismaClient } from '@prisma/client';
import axios from 'axios';

const prisma = new PrismaClient();

async function main() {
  const credential = await prisma.platformCredential.findFirst({
    where: { credentialType: 'access_token', isActive: true }
  });

  if (!credential) {
    console.error('No active token found');
    return;
  }

  const creativeId = '1246483073828207'; // One from the debug run
  const url = `https://graph.facebook.com/v19.0/${creativeId}`;
  
  try {
    const response = await axios.get(url, {
      params: {
        fields: 'id,name,body,image_url,thumbnail_url,title,object_story_spec',
        access_token: credential.credentialValue
      }
    });
    console.log('Creative Response:', JSON.stringify(response.data, null, 2));
  } catch (error: any) {
    console.error('API Error:', error.response?.data || error.message);
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
