import React from 'react';

import Button from '../components/Button';

const Index = React.createClass({
    render(){
        return (
            <div className='splash'>
                <h1 className='splash__title'><span>Farkl</span><span>e</span></h1>

                <Button to={'/games'} style={{ position: 'fixed', bottom: 20, width: '100%' }}>Games</Button>
            </div>
        )
    }
});

export default Index
