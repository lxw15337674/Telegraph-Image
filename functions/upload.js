import { errorHandling, telemetryData } from "./utils/middleware";

export async function onRequestPost(context) {
    const { request, env } = context;

    try {

        const clonedRequest = request.clone();
        const formData = await clonedRequest.formData();

        await errorHandling(context);
        telemetryData(context);

        const uploadFile = formData.get('file');
        if (!uploadFile) {
            throw new Error('No file uploaded');
        }

        const fileName = uploadFile.name;
        const fileExtension = fileName.split('.').pop().toLowerCase();

        const telegramFormData = new FormData();
        telegramFormData.append("chat_id", env.TG_Chat_ID);

        // 根据文件类型选择合适的上传方式
        let apiEndpoint;
        // if (uploadFile.type.startsWith('image/')) {
        //     telegramFormData.append("photo", uploadFile);
        //     apiEndpoint = 'sendPhoto';
        // } else if (uploadFile.type.startsWith('audio/')) {
        //     telegramFormData.append("audio", uploadFile);
        //     apiEndpoint = 'sendAudio';
        // } else {
        telegramFormData.append("document", uploadFile);
        apiEndpoint = 'sendDocument';
        // }

        const apiUrl = `https://api.telegram.org/bot${env.TG_Bot_Token}/${apiEndpoint}`;
        console.log('Sending request to:', apiUrl);

        const response = await fetch(
            apiUrl,
            {
                method: "POST",
                body: telegramFormData
            }
        );

        console.log('Response status:', response.status);

        const responseData = await response.json();

        if (!response.ok) {
            console.error('Error response from Telegram API:', responseData);
            throw new Error(responseData.description || 'Upload to Telegram failed');
        }

        const fileId = getFileId(responseData);

        if (!fileId) {
            throw new Error('Failed to get file ID');
        }

        // 将文件信息保存到 KV 存储
        if (env.img_url) {
            await env.img_url.put(`${fileId}.${fileExtension}`, "", {
                metadata: {
                    TimeStamp: Date.now(),
                    ListType: "None",
                    Label: "None",
                    liked: false,
                    fileName: fileName,
                    fileSize: uploadFile.size,
                }
            });
        }

        return new Response(
            JSON.stringify([{ 'src': `/file/${fileId}.${fileExtension}` }]),
            {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            }
        );
    } catch (error) {
        console.error('Upload error:', error);
        let errorMessage = {
            error: error.message,
            details: error.response || 'No additional details'
        };
        
        // 如果是 Telegram API 的错误响应
        if (typeof responseData !== 'undefined') {
            errorMessage.telegramResponse = responseData;
        }

        return new Response(
            JSON.stringify(errorMessage),
            {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            }
        );
    }
}

function getFileId(response) {
    console.log('Response from Telegram:', JSON.stringify(response, null, 2));
    
    if (!response.ok) {
        console.error('Response not OK');
        return null;
    }
    
    if (!response.result) {
        console.error('No result in response');
        return null;
    }

    const result = response.result;
    if (result.document) {
        console.log('Document file_id:', result.document.file_id);
        return result.document.file_id;
    }
    
    console.error('No supported file type found in response');
    return null;
}