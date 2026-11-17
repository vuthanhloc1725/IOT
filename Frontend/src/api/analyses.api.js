import { get, getBlob, postForm } from './client';
export const list = (params) => get('/analyses', params);
export const getDetail = (id) => get(`/analyses/${id}`);
export const getImage = (id) => getBlob(`/analyses/${id}/image`);
export const predict = (file) => {
  const formData = new FormData();
  formData.append('file', file);
  return postForm('/analyses/predict', formData);
};
