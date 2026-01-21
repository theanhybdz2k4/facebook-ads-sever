import axios from 'axios';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.join(__dirname, '../.env') });

const API_URL = 'http://localhost:3000/api/v1';
const API_KEY = process.env.INTERNAL_API_KEY;

async function testDispatch() {
    console.log('Testing dispatch with custom dates...');
    const today = new Date().toISOString().split('T')[0];
    
    try {
        const response = await axios.post(
            `${API_URL}/internal/n8n/dispatch`,
            {
                dateStart: today,
                dateEnd: today
            },
            {
                headers: {
                    'x-internal-api-key': API_KEY,
                    'Content-Type': 'application/json'
                }
            }
        );

        console.log('Response Status:', response.status);
        console.log('Response Data:', JSON.stringify(response.data, null, 2));
    } catch (error: any) {
        console.error('Dispatch failed:', error.response?.data || error.message);
    }
}

testDispatch();
