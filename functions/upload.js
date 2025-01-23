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

        // 并发处理所有文件上传
        const uploadPromises = files.map(file => processFileUpload(file, env));
        const results = await Promise.all(uploadPromises);

        // 过滤掉上传失败的结果
        const successfulUploads = results.filter(result => result !== null);

        return new Response(
            JSON.stringify(successfulUploads.map(result => ({ 'src': result.src }))),
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

async function processFileUpload(uploadFile, env) {
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

        const fileId = getFileId(responseData);
        if (!fileId) {
            console.error('Failed to get file ID for:', fileName);
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

        return {
            src: `/file/${fileId}.${fileExtension}`,
            fileName: fileName
        };

    } catch (error) {
        console.error('Error processing file:', uploadFile.name, error);
        return null;
    }
}

function getFileId(response) {
    if (!response.ok || !response.result) {
        return null;
    }

    const result = response.result;
    if (result.document) {
        return result.document.file_id;
    }
    if (result.video) {
        return result.video.file_id;
    }

    return null;
}