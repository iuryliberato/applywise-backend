function normalizeJobUrl(rawUrl) {
    if (!rawUrl) return '';
  
    let urlString = rawUrl.trim();
  
    if (!/^https?:\/\//i.test(urlString)) {
      urlString = 'https://' + urlString;
    }
  
    let url;
    try {
      url = new URL(urlString);
    } catch (err) {
      console.error('normalizeJobUrl: invalid URL given:', urlString, err);
      return rawUrl;
    }
  
    const host = url.hostname;
  
    if (host.includes('linkedin.com')) {
      const currentJobId = url.searchParams.get('currentJobId');
      if (currentJobId) {
        return `https://www.linkedin.com/jobs/view/${currentJobId}`;
      }
  
      const viewMatch = url.pathname.match(/\/jobs\/view\/(\d+)/);
      if (viewMatch) {
        const id = viewMatch[1];
        return `https://www.linkedin.com/jobs/view/${id}`;
      }
  
      return url.toString();
    }
  
    if (host.includes('indeed.com')) {
      const jk = url.searchParams.get('jk');
      if (jk) {
        return `https://www.indeed.com/viewjob?jk=${jk}`;
      }
  
      if (url.pathname.includes('/viewjob')) {
        const jkParam = url.searchParams.get('jk');
        if (jkParam) {
          return `https://www.indeed.com/viewjob?jk=${jkParam}`;
        }
      }
  
      return url.toString();
    }
  
    return url.toString();
  }
  
  module.exports = { normalizeJobUrl };
  