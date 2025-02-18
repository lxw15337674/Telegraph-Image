import { errorHandling, telemetryData } from "./utils/middleware";

export async function onRequestPost(context) {
    const { request, env } = context;

    try {
        const clonedRequest = request.clone();
        const formData = await clonedRequest.formData();

        await errorHandling(context);
        telemetryData(context);

        // 获取所有上传的文件
        const files = [];
        for (const [key, value] of formData.entries()) {
            if (key === 'file[]' || key === 'file') {  // 支持单文件和多文件上传
                files.push(value);
            }
        }

        if (files.length === 0) {
            throw new Error('No files uploaded');
        }

        // 并发处理所有文件上传，传入 request 对象
        const uploadPromises = files.map(file => processFileUpload(file, env, request));
        const results = await Promise.all(uploadPromises);

        // 过滤掉上传失败的结果
        const successfulUploads = results.filter(result => result !== null);

        return new Response(
            JSON.stringify(successfulUploads.map(result => ({ 'src': result.src, 'thumbnail': result.thumbnail }))),
            {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            }
        );

    } catch (error) {
        console.error('Upload error:', error);
        return new Response(
            JSON.stringify({
                error: error.message,
                details: error.response || 'No additional details'
            }),
            {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            }
        );
    }
}

async function processFileUpload(uploadFile, env, request) {
    try {
        const fileName = uploadFile.name;
        const fileExtension = fileName.split('.').pop().toLowerCase();

        const telegramFormData = new FormData();
        telegramFormData.append("chat_id", env.TG_Chat_ID);
        telegramFormData.append("document", uploadFile);

        const apiUrl = `https://api.telegram.org/bot${env.TG_Bot_Token}/sendDocument`;
        const response = await fetch(apiUrl, {
            method: "POST",
            body: telegramFormData
        });

        const responseData = await response.json();

        if (!response.ok) {
            console.error('Error uploading file:', fileName, responseData);
            return null;
        }
        const fileInfo = getFileInfo(responseData);
        if (!fileInfo) {
            console.error('Failed to get file info for:', fileName);
            return null;
        }
        // 将文件信息保存到 KV 存储
        if (env.img_url) {
            await env.img_url.put(`${fileInfo.fileId}.${fileExtension}`, "", {
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

        const baseUrl = new URL(request.url).origin;
        return {
            src: `${baseUrl}/file/${fileInfo.fileId}.${fileExtension}`,
            fileName: fileName,
            width: fileInfo.width,
            height: fileInfo.height,
            thumbnail: fileInfo.thumbnail ? {
                src: `${baseUrl}/file/${fileInfo.thumbnail.file_id}.${fileExtension}`,
                width: fileInfo.thumbnail.width,
                height: fileInfo.thumbnail.height
            } : null
        };

    } catch (error) {
        console.error('Error processing file:', uploadFile.name, error);
        return null;
    }
}

function getFileInfo(response) {
    if (!response.ok || !response.result) {
        return null;
    }

    const result = response.result;
    if (result.sticker){
        return {
            fileId: result.sticker.file_id,
            width: result.sticker.width || null,
            height: result.sticker.height || null,
            thumbnail: result.sticker.thumbnail ? {
                file_id: result.sticker.thumbnail.file_id,
                file_size: result.sticker.thumbnail.file_size,
                width: result.sticker.thumbnail.width,
                height: result.sticker.thumbnail.height
            } : null
        }
    }
    if (result.document) {
        return {
            fileId: result.document.file_id,
            width: result.document.width || null,
            height: result.document.height || null,
            thumbnail: result.document.thumbnail ? {
                file_id: result.document.thumbnail.file_id,
                file_size: result.document.thumbnail.file_size,
                width: result.document.thumbnail.width,
                height: result.document.thumbnail.height
            } : null
        };
    }
    if (result.video) {
        return {
            fileId: result.video.file_id,
            width: result.video.width || null,
            height: result.video.height || null,
            thumbnail: result.video.thumbnail ? {
                file_id: result.video.thumbnail.file_id,
                file_size: result.video.thumbnail.file_size,
                width: result.video.thumbnail.width,
                height: result.video.thumbnail.height
            } : null
        };
    }

    return null;
}