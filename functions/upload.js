import { errorHandling, telemetryData } from "./utils/middleware";

export async function onRequestPost(context) {
    const { request, env } = context;

    try {
        const clonedRequest = request.clone();
        const formData = await clonedRequest.formData();

        await errorHandling(context);
        telemetryData(context);

        // 获取所有上传的文件
        const files = formData.getAll('file');
        if (!files || files.length === 0) {
            throw new Error('No files uploaded');
        }

        // 并行处理所有文件上传
        const uploadPromises = files.map(file => uploadFileToTelegram(file, env));
        const results = await Promise.all(uploadPromises);

        // 过滤掉失败的上传
        const successfulUploads = results.filter(result => result !== null);

        if (successfulUploads.length === 0) {
            throw new Error('All file uploads failed');
        }

        return new Response(
            JSON.stringify(successfulUploads),
            {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            }
        );
    } catch (error) {
        console.error('Upload error:', error);
        return new Response(
            JSON.stringify({ error: error.message }),
            {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            }
        );
    }
}

async function uploadFileToTelegram(uploadFile, env) {
    try {
        const fileName = uploadFile.name;
        const fileExtension = fileName.split('.').pop().toLowerCase();

        const telegramFormData = new FormData();
        telegramFormData.append("chat_id", env.TG_Chat_ID);
        telegramFormData.append("document", uploadFile);
        const apiEndpoint = 'sendDocument';

        const apiUrl = `https://api.telegram.org/bot${env.TG_Bot_Token}/${apiEndpoint}`;
        console.log('Sending request to:', apiUrl);

        const response = await fetch(apiUrl, {
            method: "POST",
            body: telegramFormData
        });

        console.log('Response status:', response.status);

        const responseData = await response.json();

        if (!response.ok) {
            console.error('Error response from Telegram API:', responseData);
            return null;
        }

        const fileId = getFileId(responseData);

        if (!fileId) {
            console.error('Failed to get file ID');
            return null;
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

        return { 'src': `/file/${fileId}.${fileExtension}` };
    } catch (error) {
        console.error('Error uploading file:', error);
        return null;
    }
}

function getFileId(response) {
    if (!response.ok || !response.result) return null;

    const result = response.result;
    // if (result.photo) {
    //     return result.photo.reduce((prev, current) =>
    //         (prev.file_size > current.file_size) ? prev : current
    //     ).file_id;
    // }
    if (result.document) return result.document.file_id;
    // if (result.video) return result.video.file_id;
    // if (result.audio) return result.audio.file_id;

    return null;
}